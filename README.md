# media-watermark

> **⚠️ 许可证：AGPL-3.0（GNU Affero General Public License v3.0）** —— 全文见根目录 [`LICENSE`](./LICENSE)。
>
> 本项目采用**强 Copyleft** 许可：**只要你在网络上提供本软件（或其修改版）的功能（包括部署为 Web 服务），就必须向所有使用者公开完整源代码。**
> 请勿在闭源 / 商业产品中擅自使用本项目代码，否则构成侵权。
>
> 本工具使用的 Adobe TrustMark 模型文件（`model/*.onnx`）版权归 Adobe 所有，采用 **MIT 许可**（许可全文见 [`model/LICENSE`](./model/LICENSE)）。

图片隐形水印工具（基于 Adobe TrustMark **Q** 变体）。支持命令行与 Web 两种用法；水印肉眼不可见，可抗 JPEG 压缩、缩放、裁切等常见变换。

---

## 技术栈

- **运行时**：[Bun](https://bun.sh/) —— 唯一运行时，不依赖 Node / Python
- **模型推理**：[onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)（ONNX Runtime）
  - 编码 / 解码：DirectML（GPU）优先，不可用时自动下退到 CPU
  - 检测：**固定 CPU**（DirectML 对检测器的 NMS/RoI 支持不佳，会出错甚至崩溃）
- **图像处理**：[sharp](https://sharp.pixelplumbing.com/)（libvips）
- **Web 服务**：[Hono](https://hono.dev/)
- **打包**：[tar-stream](https://www.npmjs.com/package/tar-stream)
- **水印模型**：Adobe TrustMark **Q** 变体（**MIT 许可**，版权归 Adobe，许可全文见 `model/LICENSE`）
  - `model/encoder_Q.onnx` 编码器
  - `model/decoder_Q.onnx` 解码器
  - `model/detector_Q.onnx` 检测器（盲定位水印区域，Faster R-CNN）

---

## 目录结构

```
media-watermark/
├── media-watermark.exe      可执行文件（Windows）
├── config.jsonc             配置文件（用户自行维护，软件不会生成/改写）
├── model/                   水印模型（ONNX）+ LICENSE（模型许可，MIT）
├── runtime/                 外置运行库（onnxruntime-node / sharp）
├── webui/                   Web 前端页面（add.html / check.html）
└── README.md
```

> ⚠️ exe 依赖同级的 `model/` 与 `runtime/` 目录，**不能只拷贝 exe**。

---

## 快速开始

### 双击运行（推荐）

双击 `media-watermark.exe` → 自动启动 Web 服务并打开浏览器到添加页：

```
http://localhost:6969/add.html
```

（不带子命令时默认等同于 `web`。）

### 命令行

```bash
# 启动 Web 服务（默认端口 6969，自动打开浏览器；--noOpen 可关闭）
media-watermark web

# 给整张图添加水印
media-watermark add -i 输入.png -o 输出.png -w "hello"

# 指定内容模式（ascii / utf8 / bits）
media-watermark add -i 输入.png -o 输出.png -w "hello" --mode ascii

# 检测水印（盲定位，输出水印位置与内容）
media-watermark check -i 输出.png
```

常用选项：

| 选项 | 说明 |
|---|---|
| `-i, --inputPath` | 输入图片路径 |
| `-o, --outputPath` | 输出图片路径（add） |
| `-w, --watermarkContent` | 水印内容 |
| `--mode <ascii\|utf8\|bits>` | 内容模式（默认 utf8） |
| `-s, --wmStrength <数字>` | 水印强度（默认 0.8，官方推荐 0.7~1.5） |
| `-c, --config <路径>` | 指定配置文件 |
| `-h, --help` | 显示帮助 |

---

## Web 页面

**添加页** `http://localhost:6969/add.html`

- 填图片路径（服务端路径）→「加载图片」
- **拖拽画框**，或点「+ 新增水印」；点选后可**拖动**、拖**四角缩放**
- 右侧「微调」：直接输入**左上 / 右下坐标**，或鼠标**悬停滚轮**调整（Shift 加速）
- 点「添加水印」生成结果，右侧「结果预览」显示
- 右上角「检测页 ↗」新标签跳到检测页

**检测页** `http://localhost:6969/check.html`

- 填图片路径 →「检测水印」→ 绿色框标出位置，并显示**内容**与**模式**

### HTTP API

| 方法 | 路径 | 请求 / 返回 |
|---|---|---|
| GET | `/api/image?path=<服务端路径>` | 读取图片（供前端展示） |
| POST | `/api/add` | `{filepath, watermarkPosition: [[{x,y},{x,y}],...], watermarkContent, mode, outputFile}` → `{ok, outputFile, psnr}` |
| POST | `/api/check` | `{outputFile}` → `[{position:[{x,y},{x,y}], content, mode}]`（未命中为 `[]`） |

---

## 配置文件 `config.jsonc`

| 字段 | 说明 |
|---|---|
| `modelFile` | 编码器模型路径（默认 `model/encoder_Q.onnx`） |
| `decoderFile` | 解码器模型路径（默认 `model/decoder_Q.onnx`） |
| `detectorFile` | 检测器模型路径（默认 `model/detector_Q.onnx`） |
| `modelMode` | 运行模式数组，按序优先（默认 `["dml","cpu"]`；检测器始终 CPU） |
| `wmStrength` | 水印强度，默认 0.8（官方推荐 0.7~1.5） |
| `threads` | 推理线程数（`"full"` 或正整数，超出逻辑核心数报错） |
| `webPort` | Web 服务端口（默认 6969） |
| `detectThreshold` | 检测置信度阈值（默认 0.5） |
| `outputPath` / `inputPath` / `watermarkContent` / `mode` | add 的默认值 |

---

## 水印规则（重要）

- **区域形状**：矩形，**长宽比 ≤ 2:1**（长边最多为短边的 2 倍），**短边 ≥ 150 像素**
- **互不重叠**：同一张图内多个水印区域不能重叠
- **个数**：不限（但检测器单次最多输出 4 个框）

### 内容模式与容量

载荷共 **100 位**：`magic(16) + 模式(2) + 长度(6) + 内容(64) + CRC8(8)` + 4 位折叠校验。

| 模式 | 编码 | 容量 |
|---|---|---|
| `ascii` | 每字符 7 位 | 最多 **9 个字符** |
| `utf8` | 每字节 8 位 | 最多 **8 字节** |
| `bits` | 原始位 | 最多 **63 位** |

---

## 注意事项 / 特殊情况

1. **检测框与添加框可能不一致，这是正常的。**
   检测器对**非正方形**水印的定位不精确（框可能偏大 / 偏小 / 长宽比不对）。检测时会以框中心**尝试多种长宽比与尺寸**去解码，因此**内容能准确读出，但显示的位置是近似的**。正方形水印定位较准。

2. **重叠水印无法检测。** 两个水印区域重叠时，重叠区是两份水印信号叠加，模型无法分离，解不出来。

3. **过小的水印可能漏检。** 水印占画面比例过小（约 < 1/6）时，检测器可能框不到；超大图建议分块处理。

4. **整图水印**（CLI 默认）：水印覆盖整张图，检测时通常返回整图区域（或几个高度重叠的近似框）。

5. **首次运行较慢。** 首次加载模型 / 首次使用 DirectML 需编译算子缓存（数秒），之后很快。

6. **检测器固定使用 CPU**（刻意为之）：DirectML 对检测器（Faster R-CNN 的 NMS/RoI）支持不佳，会输出错误结果甚至崩溃；编码 / 解码仍走 DirectML（GPU）。

7. **配置文件不会被软件改写。** `config.jsonc` 完全由用户维护，程序只在启动时读取；缺省时使用内置默认值。

8. **水印强度**：数值越大越明显、越抗压缩，但画质略降。默认 0.8 在低噪声场景下仍可可靠识别；抗打印等高强度场景可用 1.5。

---

## 从源码构建

```bash
bun install
bun run build
# 生成 dist/media-watermark/（exe + runtime + model + webui + config + README）
# 并打包为 dist/media-watermark-<平台>-<架构>.tar
```
