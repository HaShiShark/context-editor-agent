# Local Dev Environment Skill
## 我的环境

- OS: Windows 11 23H2，Build 22631.6199

- Shell:
  - PowerShell: Windows PowerShell 5.1.22621.6133
  - Git Bash: GNU bash 5.2.37，路径 `D:\Git\bin\bash.exe`
  - WSL: 已安装 WSL 平台，默认版本为 WSL 2

- WSL / Linux:
  - 类型：WSL2，不是独立虚拟机，也不是双系统
  - 发行版：Ubuntu 24.04.1 LTS
  - 默认用户：hashishark
  - Linux home：/home/hashishark
  - Windows 里的磁盘文件：C:
    \Users\86138\AppData\Local\Packages\CanonicalGroupLimited.Ubuntu_79rhkp1fndgsc\LocalState\ext4.vhdx
  - WSL 版本: 2.7.3.0
  - Linux Kernel: 6.6.114.1-1
  - WSLg: 1.0.73
  - 当前检查结果：没有注册中的 Linux 发行版
  - `wsl --list --all --verbose` 未列出 Ubuntu/Debian 等发行版
  - `wsl -d Ubuntu` 返回 `WSL_E_DISTRO_NOT_FOUND`
  - 说明：本机有 WSL 能力，但当前没有可用的 Linux distro 环境；如果后续安装 Ubuntu，再补充 Ubuntu 版本、Linux 内部 Python/Node/Docker 信息。

- Python 环境:
  - Anaconda base: Python 3.10.19，路径 `D:\code\Anaconda\python.exe`
  - conda env `pytorch`: Python 3.10.0，路径 `C:\Users\86138\.conda\envs\pytorch`
  - conda env `wenfxi`: Python 3.12.13，路径 `C:\Users\86138\.conda\envs\wenfxi`
  - 独立 Python 3.13.5，路径 `C:\Users\86138\AppData\Local\Programs\Python\Python313\python.exe`
  - 当前项目 `.venv`: Python 3.10.19，路径 `.venv\Scripts\python.exe`

- Python 入口说明:
  - 当前命令行默认 `python` 命中 Anaconda: `D:\code\Anaconda\python.exe`
  - `py` 启动器存在，但 `py -0p` 没有识别到已注册 Python
  - `C:\Users\86138\AppData\Local\Microsoft\WindowsApps\python.exe` 是 Windows Store 的 Python 占位入口，不建议作为真实 Python 环境记录

- Anaconda / conda:
  - conda 版本: 25.11.1
  - conda 环境共 3 个:
    - `base`，当前激活，路径 `D:\code\Anaconda`
    - `pytorch`，路径 `C:\Users\86138\.conda\envs\pytorch`
    - `wenfxi`，路径 `C:\Users\86138\.conda\envs\wenfxi`

- Node / 包管理器:
  - Node.js: v24.13.1
  - npm: 11.8.0
  - corepack: 0.34.6
  - pip: 25.1
  - pnpm / uv / yarn / bun: 当前 PATH 下未安装或不可用

- 编辑器:
  - Antigravity: 1.107.0 x64
  - VS Code: 1.117.0 x64

  ## 代理 / VPN

- 本机系统代理已开启
- 代理地址: `127.0.0.1:7890`
- 端口连通: True
- Windows Internet Settings:
  - `ProxyEnable = 1`
  - `ProxyServer = 127.0.0.1:7890`
- 命令行环境变量里暂未设置 `HTTP_PROXY` / `HTTPS_PROXY`
- 说明：浏览器和部分系统应用会走系统代理；命令行工具不一定自动走，需要按工具单独配置。

## AI 工具

- Claude 桌面端:
  - 已安装
  - winget 识别版本: `1.4758.0.0`
  - 本地目录: `C:\Users\86138\AppData\Local\AnthropicClaude`

- Claude Code:
  - 已安装
  - 版本: `2.1.117`
  - PowerShell 入口: `C:\Users\86138\AppData\Roaming\npm\claude.ps1`

- Codex CLI:
  - 已安装
  - 版本: `codex-cli 0.130.0`
  - PowerShell 入口: `C:\Users\86138\.hash-context-codex\bin\codex.ps1`

- Codex App:
  - 已安装
  - 版本: `26.513.4821.0`

- Codex Switcher:
  - 已安装
  - 版本: `0.2.2`
  - 路径: `D:\Codex Switcher`

  ## GPU / CUDA / AI 计算环境

- GPU: NVIDIA GeForce RTX 3050 Laptop GPU
- 显存: 4GB
- NVIDIA Driver: 581.57
- nvidia-smi 显示 CUDA Version: 13.0
- `nvcc`: 当前 PATH 下未找到，说明没有配置 CUDA Toolkit 编译器，或未加入 PATH

- conda env `pytorch`:
  - Python: 3.10.0
  - PyTorch: 2.0.1+cu118
  - torch CUDA: 11.8
  - CUDA 可用: True
  - 识别设备: NVIDIA GeForce RTX 3050 Laptop GPU

- conda `base`:
  - Python: 3.10.19
  - 未安装 torch

- conda env `wenfxi`:
  - Python: 3.12.13
  - 未安装 torch

## 编译 / 开发工具链

- Go: `go1.26.2 windows/amd64`
- Java: `1.8.0_381`
- CMake: `4.3.1`
- GCC / G++: MinGW-W64 `15.2.0`
- MSVC `cl`: 当前 PATH 下未找到
- Visual Studio Build Tools: 当前未识别到
- Rust / Cargo: 当前 PATH 下未找到
- GitHub CLI `gh`: 当前 PATH 下未找到

## Git / SSH

- Git 用户名: `HaShiShark`
- Git 邮箱: `3455744878@qq.com`
- Git LFS: 已配置
- `.ssh` 目录里目前只看到 `known_hosts`，未看到常见私钥文件
- GitHub CLI `gh`: 当前未安装或未加入 PATH

## 注意事项
- 不要默认使用 Linux 命令
- 每次遇到缺少的组件尽量不要用其他的替代方式，除非确实效果差不多。否则请示用户去安装
- 遇到依赖问题时先检查 package.json / requirements.txt
- 开发时需要及时清理一些无用的文件，保证项目整洁。
- 尽量在本地改代码，不要使用worktree

