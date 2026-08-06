# Relax Eyes Desktop

一个基于 Electron 和 Spine 3.8 Runtime 的 Windows 桌面宠物应用。

宠物会常驻桌面，在后台进行自然待机和互动动作，并按照设定的时间提醒用户休息眼睛。项目当前以图图作为默认角色，默认动作是 `Relax`。

## 功能

- 支持多个 Spine 角色模型，并在切换角色后只显示该角色实际拥有的动作。
- 右键菜单保留模型原始动作；待机时随机组合播放基础动作、停顿和轻微程序化行为。
- 支持点击、悬停、拖动和贴边交互。
- 支持调整宠物显示比例，默认显示比例为 35%，并支持继续缩小。
- 支持透明、无边框、始终置顶的桌面宠物窗口。
- 默认每 20 分钟提醒一次休息，支持自定义提醒间隔、休息时长、标题和正文。
- 提醒时播放声音、显示醒目动画，并支持点击宠物确认休息。
- 倒计时放在右键菜单中，不占用宠物本体的透明窗口区域。
- 支持 Windows 便携版 EXE，无需单独安装 Node.js、npm 或 Electron 即可运行。

## 运行环境

- Windows 10/11
- Node.js 和 npm
- Spine 3.8 Runtime（项目已包含运行时文件）

## 开发运行

在当前目录执行：

```powershell
npm install
npm start
```

使用 10 秒提醒间隔进行调试：

```powershell
npm run start:debug
```

依赖安装和构建缓存可以放在当前目录中，不需要修改 Windows 系统设置。

## 构建便携版

执行：

```powershell
npm run dist:portable
```

生成的文件位于 `dist/`，文件名格式为：

```text
Relax-Eyes-Portable-<version>.exe
```

`dist/` 是构建输出目录，不应提交到源码仓库。发布 EXE 时建议使用 GitHub Releases。

## 目录说明

```text
assets/       已整理的 Spine 运行时模型文件
vendor/       Spine WebGL Runtime 及其许可文件
pets.json     角色目录、模型路径和基础动作配置
interactions.json
              点击、悬停和提醒状态对应的交互配置
main.cjs      Electron 主进程、窗口、托盘和提醒计时器
renderer.js   Spine 加载、渲染和宠物交互逻辑
preload.cjs   主进程与渲染进程之间的安全通信桥接
todo.md       后续功能和 Tauri 迁移计划
dist/         本地构建产物，不应提交
data/         便携版运行数据，不应提交
```

应用运行时会生成 `state.json`、`user-data`、`session-data`、缓存和日志。这些内容属于本机状态，不应上传到 GitHub。

## 角色模型来源与版权声明

本项目使用的部分角色 Spine 模型文件来源于以下项目：

- [Ark-Models](https://github.com/isHarryh/Ark-Models)

Ark-Models README 说明，相关模型通常由 `.atlas`、`.skel` 和 `.png` 文件组成，并使用 Spine Runtime 3.8 加载。模型资源来源项目中的原始版权声明如下：

> 本仓库中所有素材其版权归属 上海鹰角网络有限公司 所有。不得用于商业用途，不得损害版权方的利益。

本项目不主张拥有明日方舟角色、立绘、Spine 模型及相关素材的版权。角色素材仅应在符合原版权方、素材来源项目和相关第三方许可要求的前提下使用。未经明确授权，不应将这些素材用于商业用途、单独销售或声称其属于本项目作者。

`vendor/SPINE-LICENSE.txt` 中包含 Spine Runtime 的许可和版权说明，分发该运行时文件时应一并保留。

## OpenPets 来源与许可

本项目也使用或参考了 [OpenPets](https://github.com/alvinunreal/openpets) 中的部分桌面宠物相关内容，包括桌面宠物的窗口组织、交互方向和相关实现思路。OpenPets 的代码以 MIT License 发布，原项目版权归 Boring Dystopia Development 所有。

OpenPets 的原始许可文本已保存在本仓库的 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。对 OpenPets 代码的修改和再分发应继续保留原版权声明与 MIT License 条款。

## 仓库提交建议

建议提交源码、配置、文档、必要的 `assets/` 和 `vendor/` 文件；以下内容应排除：

```text
node_modules/
dist/
data/
session-data/
user-data/
state.json
*.exe
各类缓存、日志和临时文件
原始模型备份目录
```

如果要公开源代码，建议将角色模型素材单独放在私有仓库或本地素材包中，并在公开仓库中只保留素材目录说明和示例配置。当前项目更适合先使用 Private GitHub 仓库保存完整可运行版本。

## 后续计划

后续计划包括：

- 使用 Tauri 逐步替换 Electron，降低发布体积。
- 增加独立的宠物素材包和模型导入流程。
- 支持从图片生成或导入新的桌面宠物。
- 继续扩展角色行为、互动动作和提醒方式。

详细任务列表见 [todo.md](todo.md)。
