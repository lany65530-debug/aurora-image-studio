把 ffmpeg.exe（Windows）放到本目录后重新打包，即可随应用内置：
  resources/ffmpeg/ffmpeg.exe
  resources/ffmpeg/ffprobe.exe   （可选；没有时用 ffmpeg -i 兜底探测）

运行时查找顺序：
  1) 环境变量 AURORA_FFMPEG_PATH
  2) 本内置目录（安装后：<安装目录>/resources/ffmpeg/）
  3) 应用设置里的 ffmpegPath（剪辑工作区「FFmpeg」按钮选择）
  4) 系统 PATH
  5) 常见安装位置（如 C:\Program Files\File Converter、剪映 JianyingPro 自带）

未找到时：MP4 导出与格式转码不可用，自动回退为实时录制 WebM。
