$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$sc = $ws.CreateShortcut("$desktop\WCJR Assistant.lnk")
$sc.TargetPath = "D:\WCJR MCP\WCJR-MCP\launch.bat"
$sc.WorkingDirectory = "D:\WCJR MCP\WCJR-MCP"
$sc.Description = "Launch WCJR MCP Assistant"
$sc.WindowStyle = 7
$sc.Save()
Write-Host "Desktop shortcut created: $desktop\WCJR Assistant.lnk"
