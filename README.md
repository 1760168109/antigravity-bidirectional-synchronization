# antigravity-bidirectional-synchronization
同步Antigravity 1.32端与Antigravity IDE端的对话数据，由AI阿岚制作
## 使用方式
将本体文件`sync.bat`、`sync.js`存放于`.gemini`目录，
随后点击`sync.bat`即可一键运行
## 职责
1. 同步 .gemini 目录下的对话数据（conversations, brain, annotations, implicit, knowledge）
2. 合并 AppData\Roaming 中 state.vscdb 里的对话索引（仅补入 1.32 独有键，以 IDE 为准）
3. 为缺失 annotation 的对话自动生成 .pbtxt 文件
## 注意事项
- 为免损伤文件，运行前请关闭 Antigravity 和 Antigravity IDE
- 该同步脚本不同步删除信息，如果要删除对话记录，你需要在两端都进行删除，随后再运行侥幸
