Option Explicit

Dim shell, files, setupDir, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
setupDir = files.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /c " & Chr(34) & Chr(34) & setupDir & "\Start Prompt Studio Setup.cmd" & Chr(34) & Chr(34)
shell.Run command, 0, False
