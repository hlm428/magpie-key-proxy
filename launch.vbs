' Launches the magpie key-injection proxy hidden at user logon.
' Contains no credentials: the proxy reads them from the user environment.
' The script directory is derived at runtime so no non-ASCII path is hardcoded.
Option Explicit
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run """D:\node.exe"" """ & here & "\proxy.mjs""", 0, False