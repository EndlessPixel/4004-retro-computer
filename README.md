# 4004 Retro Computer

一个从指令集层面构建的 Intel 4004 模拟器，配上完整的复古计算机系统：4002 RAM、磁盘镜像、Unix 风格 shell，以及通过 HTTP 推送像素的 CRT 终端。

> A transistor-level-inspired Intel 4004 emulator with a retro computer stack: 4002 RAM, disk-backed filesystem, a Unix-like shell, and a phosphor CRT terminal that streams pixels over HTTP.

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [架构](#架构)
- [Shell 命令](#shell-命令)
- [CRT 终端原理](#crt-终端原理)
- [项目结构](#项目结构)
- [测试](#测试)
- [许可证](#许可证)

---

## 特性

- **指令级 4004 CPU** — 4 位累加器、16 个寄存器、12 位地址空间、T0–T7 机器周期时序
- **4002 RAM 与状态寄存器** — 16 芯片 × 4 bank × 16 半字节
- **磁盘持久化** — 4 KB `.img` 镜像，16 扇区 × 256 字节，写穿落盘
- **镜像内文件系统** — 目录项、文本文件、`/`、`/home` 层级
- **真实运行在 CPU 上的 shell** — `echo` 由机器码程序执行，不是 JS 字符串拼接
- **CRT 终端服务器** — 后端推 1bpp 像素帧，前端用磷光余辉模型渲染电子束轰击
- **零外部运行时依赖** — 仅 Node.js 标准库

## 快速开始

需要 Node.js 18+。

```bash
git clone https://github.com/EndlessPixel/4004-retro-computer.git
cd 4004-retro-computer

# 交互式终端（stdin/stdout）
node system.js

# CRT 终端（浏览器打开 http://localhost:15900）
node system.js -vnc
```

首次运行会在当前目录创建 `disk.img`（已在 `.gitignore` 中排除），并安装文件系统与 `echo` 程序。

```
4004/> ls
home/  echo  README
4004/> echo hello
hello
4004/> cd /home
4004/home> cat notes
HELLO FROM HOME
```

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                     Shell (system.js)                    │
│         echo / ls / cd / pwd / cat / clear / help        │
└───────────────┬──────────────────────────┬───────────────┘
                │                          │
        ┌───────▼────────┐        ┌────────▼────────┐
        │  CPU (4004.js) │        │ FileSystem fs.js│
        │  RAM memory.js │        │  Disk disk.js   │
        └───────┬────────┘        └────────┬────────┘
                │                          │
                └────────────┬─────────────┘
                             │ .img
                    ┌────────▼─────────┐
                    │  Framebuffer     │
                    │  Font (PSF 8x8)  │
                    └────────┬─────────┘
                             │ SSE /events
                    ┌────────▼─────────┐
                    │  CRT (crt.html)  │
                    │  Canvas + Beam   │
                    └──────────────────┘
```

CPU 通过 `WRR/RDR` 端口指令访问外设，`ioDevice` 决定路由到磁盘还是终端。`echo` 程序码存放在镜像扇区 1，运行时载入 ROM，参数写入 RAM 后由 CPU 真正执行并输出。

## Shell 命令

| 命令 | 说明 |
|------|------|
| `echo <text>` | 输出文本，支持 `\n` `\t` `\xHH` 等转义 |
| `ls [path]` | 列出目录，默认当前目录 |
| `cd [path]` | 切换目录，支持绝对路径、相对路径、`.` `..` `~` |
| `pwd` | 显示当前目录 |
| `cat <file>` | 显示文本文件内容 |
| `clear` | 清屏 |
| `help` | 帮助 |
| `exit` | 退出 |

## CRT 终端原理

这不是在网页上画终端字体模拟 CRT，而是真正的像素推送：

1. **后端帧缓冲**（`framebuffer.js`）维护 80×25 字符网格，用内嵌的 PSF 8×8 字模渲染成 640×200 的 1bpp 位图
2. **SSE 推送**（`/events`）把 base64 编码的帧实时发给浏览器
3. **电子束模型**（`crt.html`）维护 640×200 的磷光亮度缓冲，电子束每帧按光栅推进 3200 个像素，扫到亮点时充电到最大亮度，所有点每帧按指数衰减
4. 那条"扫描线"不是画上去的装饰，而是电子束移动与余辉衰减自然产生的结果

字体文件位于 `assets/Lat15-VGA8.psf.gz`，随仓库分发，跨平台无需系统字体。

## 项目结构

```
.
├── 4004.js          # Intel 4004 CPU 模拟器
├── memory.js        # ROM 与 4002 RAM
├── disk.js          # .img 磁盘设备
├── fs.js            # 镜像内文件系统
├── terminal.js      # 终端 I/O 设备
├── font.js          # PSF1 字体解析
├── framebuffer.js   # 字符网格到 1bpp 像素
├── system.js        # Shell 与 HTTP 服务器
├── crt.html         # CRT Canvas 前端
├── assets/          # 随仓库分发的字体
└── disk.img         # 运行时生成（gitignore）
```

## 测试

```bash
# CPU 时序与指令验证
node 4004.js

# 完整 shell 冒烟测试
printf 'ls\ncd /home\ncat notes\necho ok\nexit\n' | node system.js
```

## 许可证

GPL-3.0-or-later，详见 [LICENSE](LICENSE)。
