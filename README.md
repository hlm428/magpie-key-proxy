# magpie-key-proxy

magpie 的**本机密钥注入代理**。让 API 密钥只待在环境变量里，不落盘。

## 为什么需要它

magpie 的 provider key 只能明文存在 `~/.config/magpie/providers.json`，它**不解析环境变量占位符**：把 key 设成 `${NVIDIA_API_KEY}`，magpie 会把这个字面量当 Bearer token 发出去，上游回 401。

如果同时要求「密钥不写进任何文件」，这两件事就撞上了。本代理解决这个矛盾：

- magpie 的 `key` 字段留占位符（magpie 要求非空），`chat` 地址指向本代理；
- 代理从**进程环境变量**读真密钥，覆盖 `Authorization` 头，再转发到上游。

密钥全程只在环境变量和内存里，不进脚本、不进配置、不进日志、不进响应体。

## 安全边界（先读这段）

- **只监听 `127.0.0.1`**，不对外暴露。
- **没有鉴权**。只听回环是唯一的访问控制，所以本机任何进程都能通过它用到你的密钥额度。这是「密钥不落盘」的固有取舍——不要把它绑到别的地址，也不要给它加端口转发。
- 上游主机名**写死在路由表里**，请求方无法把转发指向别的主机。
- 路径校验拒绝 `..` / `.` 段、控制字符、不以 `/` 开头或以 `//` 开头的路径；方法白名单 `GET/HEAD/POST/OPTIONS/DELETE`；请求体上限 64 MiB。
- 日志只有路由名、模型名、状态码、耗时，**没有任何密钥**。

## 运行要求

Node 24+（用原生 `fetch` 和 `Readable.fromWeb`）。**无第三方依赖，不需要 `npm install`。**

## 环境变量

| 变量 | 用途 |
|---|---|
| `NVIDIA_API_KEY` | `/nvidia/*` 的 Bearer token |
| `ITERACOMPUTE_API_KEY` | `/iteracompute/*` 的 Bearer token |
| `KEY_PROXY_PORT` | 可选，监听端口，默认 `3426` |

启动时读一次，之后只留在内存。某条路由的变量没设，**该路由**返回 503 并说明缺哪个变量名，另一条照常工作，不会整个崩掉。

**轮换密钥后需要重启进程才生效。**

Windows 上建议用 `setx` 存成用户级环境变量，不要写进任何文件。

## 监听与分流

默认 `127.0.0.1:3426`，单端口按路径分流：

| 路径 | 转发到 |
|---|---|
| `/nvidia/*` | `https://integrate.api.nvidia.com/v1/*` |
| `/iteracompute/*` | `https://api.iteracompute.com/v1/*` |
| `/health` | 不转发，返回各路由的 `keyPresent` 布尔值 |

```
curl http://127.0.0.1:3426/health
```

`keyPresent` 只报「有没有读到密钥」，不报值。这也是验证开机自启有没有正确继承环境变量的办法。

## magpie 侧怎么配

```
magpie provider set nvidia url=http://127.0.0.1:3426/nvidia
magpie provider set iteracompute url=http://127.0.0.1:3426/iteracompute
```

`key` 字段保持占位符 `${NVIDIA_API_KEY}` / `${ITERACOMPUTE_API_KEY}`。magpie 发出来的占位符会被代理在转发前覆盖掉，所以 magpie 那边不需要知道真密钥。

## 流式与超时

- 上游响应体用 `Readable.fromWeb(upstream.body).pipe(res)` **直通，不缓冲**；`res.flushHeaders()` 立刻把头发给客户端，首字节不被代理拖延。
- `server.requestTimeout = 0`（关掉 Node 默认的 5 分钟整体超时）
- 上游 `fetch` 超时 **30 分钟**
- `headersTimeout` 60s，`keepAliveTimeout` 75s
- 客户端断开时 abort 上游请求，不留悬空连接

实测某上游模型首个 token 要等 110 秒、整条链路 115 秒，代理没有先断。**不要给这条链路设短超时。**

一个容易踩的坑：Node 的 `fetch` 会**自动解压** gzip/br，但保留上游的 `content-encoding` 头。照抄该头会让客户端二次解压报错。本代理剥掉响应的 `content-encoding` 与 `content-length`，请求侧剥掉 `accept-encoding` 让上游回 identity。

## 日志与轮转

`proxy.log`，每请求一行，追加写：

```
2026-11-10T17:06:12.431Z iteracompute model=qwen3.8-27b status=200 ms=13021
```

字段只有时间、路由、模型名、状态码、耗时。上游 `fetch` 抛异常时**故意不记异常对象**（它可能引用请求细节），只记 `status=502`。

**轮转规则**：写入前若「现有大小 + 本行」会超过 **1 MiB（1048576 字节）**就先轮转，`proxy.log` → `.1` → `.2` → `.3`，最旧的 `.3` 被删除。所以同时最多 4 个文件，总量约 4 MiB 封顶，`proxy.log` 本身始终不超过 1 MiB。

每行都重新打开文件，整个「检查大小—轮转—追加」是**同步**的，所以不会丢行，也不会打断正在跑的请求。日志文件不入库（见 `.gitignore`）。

## 开机自启（Windows）

用**计划任务**，不用 HKCU Run 键。原因：Run 键由 Explorer 拉起，而 Explorer 的环境是本次登录时建立的快照，`setx` 之后的新变量它未必看得到；计划任务由任务计划服务以用户令牌**新建环境块**（含 `HKCU\Environment`），能读到最新的用户环境变量。

| 项 | 值 |
|---|---|
| 任务名 | `MagpieKeyProxy` |
| 触发器 | 当前用户登录时（`-AtLogOn`） |
| 主体 | 当前用户 / `Interactive` / `Limited`（非管理员） |
| 动作 | `wscript.exe "<本目录>\launch.vbs"` |
| 执行时限 | **`PT0S` = 无限制** |

**执行时限必须设 `PT0S`**：计划任务默认 3 天后强杀进程，而代理是常驻服务，不改这条三天后就没了。

`launch.vbs` 以窗口样式 0（隐藏）拉起 node，登录时不弹黑框。它用 `WScript.ScriptFullName` 在运行时推导自身目录，**脚本里没有任何非 ASCII 字面量**，中文路径由 Windows 原生 Unicode 传入，绕开 VBS/控制台的代码页坑。

> **注意**：`launch.vbs` 里 node 的路径写死为 `D:\node.exe`。换机器或 node 装在别处时，要改这一行。

注册示例（PowerShell，`$vbs` 换成 `launch.vbs` 的实际绝对路径）：

```powershell
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$settings.ExecutionTimeLimit = 'PT0S'
$settings.Hidden = $true
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'MagpieKeyProxy' -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force
```

**已知局限**：VBS 拉起 node 后自己就退出了，计划服务看到的是「动作已完成」，所以失败重试**管不到 node 崩溃**的情况。登录自启是覆盖的，进程崩溃自愈不是。要崩溃自愈得让计划任务直接跑 node（代价是登录时可能弹控制台窗口）。

## 手动运行

```
node proxy.mjs
```

## 文件

| 文件 | 作用 |
|---|---|
| `proxy.mjs` | 代理本体 |
| `launch.vbs` | 隐藏窗口启动器 |
| `README.md` | 本文档 |
| `.gitignore` | 挡住运行日志，避免把使用记录推上公开库 |
| `proxy.log` / `proxy.log.1..3` | 运行日志，**不入库** |