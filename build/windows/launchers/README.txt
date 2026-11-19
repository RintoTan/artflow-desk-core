ArtFlow Desk Core — Windows 启动脚本说明

「启动 QA Clean（空白环境）.cmd」
  作用：以 clean 场景启动 QA 版，得到一个空白数据环境。
  用法：双击即可。若提示找不到程序，请先安装 QA 版安装包。

为什么需要它：
  QA 版默认进入 seeded（预置演示数据）场景，双击桌面/开始菜单图标看到的是演示数据。
  这个脚本通过设置 AF_MINIDESK_QA_SCENARIO=clean 启动，数据保存在另一个独立目录，
  不会覆盖 seeded 的数据，也不会影响正式版。

两个场景的数据位置（Windows）：
  seeded  %APPDATA%\dev.artflow.minidesk.qa\seeded
  clean   %APPDATA%\dev.artflow.minidesk.qa\clean
  正式版  %APPDATA%\dev.artflow.minidesk
