# JoyCode for Magpie

在 Magpie 中使用 JoyCode 账号的模型和额度。根据模型声明选择 Chat Completions、Responses 或 Anthropic 接口，也可以指定自己的网关。

基于 [magpie-community/plugins 的 JoyCode 插件](https://github.com/magpie-community/plugins/tree/main/packages/joycode) 修改，保留 MIT 许可。这是非官方插件，与京东及 Magpie 官方无隶属关系。

## 安装

```sh
magpie plugin add github:SevenFo/magpie-joycode
magpie plugin login joycode
```

已安装上游插件时，先移除上游插件，再安装本 fork，避免两个插件同时接管 `joycode`。Magpie 会保留已有登录。

## 模型目录和思考强度

`0.2.3` 从账号模型目录的 `extJson.reasoning`（也兼容 JSON 字符串 `ext`）读取每个模型的档位和默认值，声明 reasoning 能力和 variants。不会根据模型名字给所有模型填相同档位。Responses 请求保留原生 `reasoning.effort`；Chat 请求保留 `reasoning_effort`，只对上游标记 `sendThinking` 的模型补充 thinking 开关，保留调用方已有设置。

正常登录后展示的模型名称、可见性和每个模型的档位来自运行时登录账号的上游目录，不在此处列出任何账号的模型清单。验收覆盖了能力声明、合法与非法档位、参数传递及工具调用往返。部分后端不严格校验未知档位，因此不能单凭 HTTP 成功证明内部计算强度发生变化。

模型目录只从当前登录账号的接口获取，不内置型号列表，也不从旧的供应商模型声明中回填能力。未登录、目录查询失败或返回无效数据时，插件返回空目录；登录失效仍会提示重新登录。已选择的型号不会被这次目录查询改写。

## 网关

默认使用 JoyCode 公网签名网关，无需额外配置。

通过命令行设置，配置保存在 Magpie 本机：

```sh
magpie plugin options magpie-joycode '{"gatewayMode":"color","baseURL":"https://gateway.example.com"}'
```

`color` 使用签名 RPC 网关；如果网关提供标准模型 API，改用 `direct`，地址填到 API 前缀：

```json
{
  "gatewayMode": "direct",
  "baseURL": "https://gateway.example.com/v1"
}
```

`direct` 下，登录校验、模型列表和额度查询仍走默认公网网关；需要更改时，另设 `accountBaseURL`。也支持 `JOYCODE_GATEWAY_MODE`、`JOYCODE_BASE_URL` 和 `JOYCODE_ACCOUNT_BASE_URL` 环境变量，插件选项优先。

真实地址只填在本机配置中。网关会收到账号票据和请求内容，请填写自己信任的地址；HTTP 地址没有传输加密。插件不跟随重定向。

`flatten` 仅用于 Chat Completions 的纯文本回退；启用后会丢弃工具定义，不适合工具会话。

## 开发

```sh
npm test
```

运行代码在 `packages/joycode`，其余目录保留自上游，安装本 fork 不会安装其他插件。推送版本标签会运行测试并生成 GitHub Release，无需发布到 npm。
