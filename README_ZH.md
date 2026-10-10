# Gacha Director

**ComfyUI 里的 MiniMax H3 一站式导演台：批量生成候选，每个镜头挑最好的一条，合成成片。**

[English](README.md) | [日本語](README_JA.md) | 中文

https://github.com/user-attachments/assets/4ab0e2a9-b260-47e5-8df9-826cfff57b43

宣传片（15 秒），用 Gacha Director 制作。

用户友好的界面，把镜头编排、素材管理和选片集中在一个面板里。面向 **Edit + 多镜头 Gacha Generate**：在「剪辑」页编排镜头，到「生成」页批量生成、逐镜头选片。适合大批量调优和出片。

https://github.com/user-attachments/assets/1d01bf37-fab6-4222-8e08-b9cb88085edc

功能演示（70 秒）。

> [!NOTE]
> **AI-Friendly**：[AGENTS.md](AGENTS.md) 是给你的 AI 助手的交接文档，供它理解、讲解和修改这个项目。

## 它能做什么

**批量生成，逐镜头选片，一键合成。** 一次生成多条候选。哪个镜头不满意，就换成另一条候选里的同一个镜头，其他镜头保持原来的选择。

![四个镜头里给一个镜头换候选，再合成](docs/reel-swap.webp)

**每个镜头一张卡片。** 写这个镜头里发生什么，加上图片、视频或声音，再给每份素材选一个用途。

![剪辑页：每个镜头一张卡片，左边写内容，右边加素材](docs/zh/edit-shots.jpg)

**编辑已有视频。** 写下要改什么、保留什么，比如把一段实拍改成雪天。

![左：源视频；右：改成雪天的成片](docs/example-edit.webp)

**长镜头中途也能换候选。** 对画面相近的两条候选，合成时重新生成接缝处的过渡。

![长镜头里两条候选相接：直接剪开，和重新生成接缝](docs/reel-seam.webp)

**一个节点，支持 H3 的多种用法。** 文生视频、图生视频、首尾帧、多关键帧、续写、主体和动作参考、视频编辑。

![六种用法的样片](docs/modes.webp)

界面支持中文、英文、日文。

## 安装

需要 ComfyUI 0.39 或更新版本。不用装额外的 Python 包，也不依赖别的自定义节点。

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/excifroge/ComfyUI-GachaDirector
```

重启 ComfyUI，日志里出现 `Gacha Director v2.1.2: 10 nodes registered` 就是装好了。模型文件按 [ComfyUI 官方教程](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) 准备。

## 快速开始

1. 打开示例工作流 [GachaDirector_Base.json](example_workflows/GachaDirector_Base.json)，给加载器选好模型文件；没有加速 LoRA 就删掉它的加载器。
2. 点节点上的 **打开 Gacha Director**。示例里已经有两个镜头，可以直接用，也可以在**剪辑**页改写内容、添加素材。
3. 在**生成**页点生成按钮，默认一批生成两条候选。
4. 两条候选出来后，在每个镜头下给满意的那条点**选用**，再点**合成**。

![从画布上的节点到第一批候选](docs/reel-flow.webp)

## 文档

- [使用说明](docs/GUIDE_ZH.md)
- [AGENTS.md](AGENTS.md)：给 AI 的交接文档
- [更新记录](CHANGELOG.md)

## 署名、致谢与许可

界面与制作流程设计、宣传片导演：[Excifroge](https://github.com/excifroge)

Gacha Director 基于并借鉴了以下开源项目，感谢它们的作者。各部分的来源见 [NOTICE](NOTICE)。

- [ComfyUI-MiniMaxH3-Director](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director)：seesee75 及贡献者，GPL-3.0
- [ComfyUI-MiniMax-H3-Motion-Director](https://github.com/j955229/ComfyUI-MiniMax-H3-Motion-Director)：其贡献者，GPL-3.0
- [ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)：AIMixer，Apache-2.0
- [ComfyUI-MiniMaxH3-Director](https://github.com/Thefrizzy1/ComfyUI-MiniMaxH3-Director)：the_frizzy1，Apache-2.0
- LTX Director：WhatDreamsCost，GPL-3.0
- [ComfyUI](https://github.com/Comfy-Org/ComfyUI)：GPL-3.0

样片和截图里的画面来自开放电影《Sintel》（© Blender Foundation，CC BY 3.0，[durian.blender.org](https://durian.blender.org/)）和《Tears of Steel》（(CC) Blender Foundation，CC BY 3.0，[mango.blender.org](https://mango.blender.org/)），其余由 MiniMax H3 生成。

宣传片里的吉祥物是《鸣潮》（Wuthering Waves）角色菲比的同人形象，角色及开头那一声语音归库洛游戏（Kuro Games）所有。

本包含有 GPL-3.0 代码，以 [GPL-3.0](LICENSE) 发布。
