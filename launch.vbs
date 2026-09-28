' Emotional AI 启动器：隐藏控制台窗口，后台运行 npm run dev
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\wangq\Documents\trae_projects\Emotional AI"
sh.Run "cmd /c npm run dev", 0, False
