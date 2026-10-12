# omp-extension-guard

一個 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）套件：不讓沒審過的程式碼在 omp 的行程裡執行。omp 會從啟動目錄載入 extension、hook、自訂工具和 plugin，並在第一次模型請求之前、在它自己的行程裡、帶著你的權限和環境變數執行它們。這個套件列出每一個這樣的程式碼單元，讓具名審核人在簽章清單裡逐一核准，只帶核准的單元啟動 omp，並在 session 中防止 agent 植入新的啟動程式碼。

[English](README.md)

> **沒有用真模型測過。** Live 測試跑的是真的 omp 18.2.8，模型換成測試用的腳本模型（開發這台機器沒有網路）。它證明的是什麼會載入、什麼會執行、guard 擋下什麼；不證明真模型會怎麼做。

## 為什麼

extension 是程式碼，不是文字。omp 對 Cursor 系列的 Day 21 實測過：clone 下來的 repo 在 `.omp/extensions/` 附帶的 extension，在 omp 啟動時、你還沒輸入任何東西之前就執行，讀得到憑證環境變數、能寫檔；旁邊載入的 guard 一樣都看不到，因為 guard 和 extension 在同一個行程。omp 自己的 README 也這麼說：那些旗標「narrow inputs without changing the repository-trust model」。

讀 omp 18.2.8 的原始碼，會載入的不只 extension 目錄：

- `.omp/tools/`、`.claude/tools/`、`.codex/tools/` 的自訂工具，以及已安裝 plugin 的工具，加了 `--no-extensions --no-tools` 照樣載入（[#14878](https://github.com/can1357/oh-my-pi/issues/14878)）。
- repo 可以附帶自己的 plugin 根目錄 `.omp/plugins/`，它的工具沒有任何旗標或使用者設定關得掉。
- 用 npm 安裝的 omp，Bun 會在 omp 自己的程式碼之前，執行啟動目錄 `bunfig.toml` 的 preload，並載入該目錄的 `.env`。

旗標決定什麼載入，關不住已經載入的東西。所以這個套件把決定移到行程外：什麼准載入，在 omp 啟動前核准；真的憑證留在行程外；行程內的 guard 只檢查它看得到的東西。

## 怎麼組在一起

1. **審核，omp 執行前。** `omp-extension-guard inventory` 列出 omp 會載入的每個單元和作者。審核人在核准檔裡寫下每個單元的來源、版本或 commit，以及自己的名字；`allowlist` 把每個單元釘在它的檔案或目錄的 digest 上；`sign` 用 agent 看不到的金鑰簽章。在 CI 裡，`check` 讓沒經核准就新增、修改、搬移或改名啟動程式碼的 pull request 失敗。
2. **憑證，omp 啟動前。** `omp-ext-safe` 給 omp 一個空環境加允許清單，再找出 omp 仍碰得到的真憑證：環境變數、omp 的參數、憑證檔，以及 omp 自己的憑證儲存。`require` 模式下，只要還有，就拒絕啟動。
3. **啟動。** `omp-ext-safe` 只帶核准的單元啟動 omp，其他的一律擋在外面：用 `--trusted-extension`（預設）、用 `--no-extensions` 加 `-e`，或保留自動發現、在設定 overlay 裡關掉每個沒核准的單元。沒核准的自訂工具用 id 關掉，這是旗標做不到的。完全沒有開關可關的沒核准程式碼，就拒絕啟動。它從空目錄啟動 omp，所以專案的 `bunfig.toml` 和 `.env` 不會載入；啟動前再用 omp 自己的 discovery 檢查一次結果。
4. **omp 執行中。** guard 擋下 agent 寫入 omp 或 Bun 會載入程式碼的位置；extension 附帶的 script，要核准清單列了才准執行；沒核准的程式碼註冊了工具，就鎖住整個 session。
5. **之後。** `omp-ext-safe` 從不含內容的稽核紀錄印出 guard 的判斷統計。銷毀沙箱、撤銷金鑰，是你的沙箱和金鑰設定要做的步驟，見[在沙箱裡用](#在沙箱裡用)。

## omp 18.2.8 啟動時會執行什麼

| 單元 | 例子 | 什麼擋得住 |
|---|---|---|
| extension 模組 | `.omp/extensions/x/`、`~/.omp/agent/extensions/x.ts`、`.omp/settings.json#extensions` | `--trusted-extension`、`--no-extensions`，或 `disabledExtensions: [extension-module:<名稱>]` |
| hook factory | `.omp/hooks/pre/x.ts`、`.claude/hooks/pre/x.ts`、`~/.omp/agent/hooks/` | 同樣的旗標，或 `hook:<type>:<tool>:<檔名>` |
| `extensions:` 設定 | repo 的 `.omp/config.yml` 裡的 `extensions: [./vendor/x]` | 旗標，或用 overlay 取代 `extensions:` |
| plugin 的 extension | `~/.omp/plugins/node_modules/x`、repo 的 `.omp/plugins/node_modules/x` | 旗標，或 `extension-module:<名稱>` |
| 自訂工具 | `.omp/tools/x.ts`、`.claude/tools/`、`.codex/tools/`、`~/.omp/agent/tools/` | 沒有旗標；只有 `disabledExtensions: [tool:<名稱>]` |
| plugin 的工具 | plugin 的 `omp.tools`，使用者或 repo 的 plugin 根目錄 | 只能移除 plugin |
| TypeScript slash 指令 | `.omp/commands/x/index.ts` | `--trusted-extension` 或 `--no-extensions` |
| Bun 的 preload 和 `.env` | 啟動目錄的 `bunfig.toml` `preload`、`.env` | 從別的目錄啟動 omp（omp 的編譯版不載入它們） |

`omp-extension-guard inventory` 會用 omp 自己的 discovery 函式，對實際專案印出這張表，而且一行都不執行。

## 做什麼

| 元件 | 在哪裡 | 做什麼 | 失敗時 |
|---|---|---|---|
| `omp-extension-guard` | 審核人、CI | `inventory` 列出每個單元的 key（`project:`、`user:`、`home:`、`abs:` 加路徑）、種類、digest，以及擋得住它的開關。`keygen`、`allowlist`、`sign`、`verify` 產生簽章清單；`allowlist` 遇到核准資料缺來源、版本或 commit、審核人，或 omp 不會載入的單元、種類和 omp 實際載入的位置不符、無法計算 digest 的單元、script 清單和單元裡的 script 不同，一律拒絕。`check` 對每個新增、修改、搬移或撤銷的單元以 1 結束。 | 以非 0 結束，不寫出任何東西。 |
| `omp-ext-safe` | 開發者的機器，omp 啟動前 | 用你的公鑰驗證清單；用 omp 自己的 discovery 盤點；檢查憑證暴露；依模式組出這次的旗標和 overlay；遇到什麼都擋不住的程式碼、和核准單元共用 id（包括沒核准的同名單元遮蔽了核准的那份），以及 `require` 模式下的憑證，就拒絕；用 omp 的 discovery 驗證計畫；有沒核准的單元時先問人（沒有終端機就拒絕，除非 `--on-unapproved exclude`）；從空目錄啟動 omp、guard 最後載入；結束後回報。 | 拒絕啟動（exit 3）。在 `--trusted-extension` 下，核准的 extension 或 guard 載入失敗時，omp 自己會中止。 |
| guard：啟動檢查 | `session_start` | 只要有工具的來源檔不在核准且沒變動的單元裡，就鎖住 session：每個工具呼叫都擋下，並告訴使用者是哪些工具、哪些檔案。完全沒設定核准時，內建工具可用，其他工具擋下。 | 錯誤寫進 log；下一道關是 `tool_call`。 |
| guard：寫入保護 | `tool_call` | 擋下 `write`、`edit`（包括改名，以及合併 patch 裡寫到的檔案）、`ast_edit` 寫入 `.omp/`、`.pi/`、`.claude/`、`.codex/`、`.mcp.json`、`bunfig.toml`、`.env*`、`~/.omp/` 和 omp 的 agent 目錄、`~/.claude/`、`~/.codex/`、`~/.pi/`、`~/.bunfig.toml`，以及本套件自己的設定、狀態、清單、金鑰和檔案；會解開 symlink。提到這些位置的 `bash` 指令，每一段都唯讀才放行；`cd` 進去、重新導向、帶著這些位置的變數、從上層遞迴刪除，以及 `omp plugin install` 都擋下。提到這些位置的 `eval` 程式碼也擋下。 | omp 擋下這次呼叫。 |
| guard：script | `tool_call` | `bash` 要執行核准單元裡的 script，必須核准清單有列，而且 script 和它所在的單元都還等於核准的 digest。 | omp 擋下這次呼叫。 |
| 稽核紀錄 | 每一次判斷 | 每次判斷一行 JSON：時間、run、事件、工具、動作、規則、單元 key。不含檔案內容，不含憑證。 | 寫入失敗只記一次 log。 |

## 需求

- [Bun](https://bun.sh) 1.3.14 以上，以及兩支 bin 包裝要用的 POSIX shell。
- omp 18.2.8。套件用的是 omp 自己的 discovery 程式；其他版本可能會從它不認得的位置載入。
- 把套件裝在 omp 旁邊：clone 下來後執行 `bun install`。載入 omp 的程式碼會讓 omp 晚幾秒啟動。

## 設定

### 一次：簽章金鑰

```bash
omp-extension-guard keygen ./keys
```

`extension-guard.key.pem` 只存成 CI 的 secret，不放別處。`extension-guard.pub.pem` 發給每個執行 `omp-ext-safe` 的人。你自己的 extension，可以另做一組個人金鑰和個人清單；`omp-ext-safe` 接受多份清單和多把公鑰。

### 啟動程式碼新增或變動時

列出 omp 會載入的東西，複製你審過的單元 key：

```bash
omp-extension-guard inventory
```

寫下每一筆核准（見 [`examples/approvals.example.json`](examples/approvals.example.json)）：

```json
{
	"items": {
		"project:.omp/extensions/dx-helper": {
			"kind": "extension",
			"source": "https://github.com/example/dx-helper",
			"commit": "0123456789abcdef0123456789abcdef01234567",
			"reviewer": "platform-team",
			"scripts": ["scripts/setup.sh"]
		}
	},
	"revoked": ["project:.omp/tools/old-helper.ts"]
}
```

接著在審核之後執行的 job 裡：

```bash
omp-extension-guard allowlist --approvals approvals.json --out extensions.allow.json --expires-in-days 30
omp-extension-guard sign --key "$EXTENSION_GUARD_KEY_FILE" extensions.allow.json
```

把 `extensions.allow.json` 和 `extensions.allow.json.sig` 發布到 repo 改不到的地方，例如 CI artifact。放在 repo 裡的清單是 repo 控制的輸入，所以 `omp-ext-safe` 只信簽章。

### CI，每個 pull request

```bash
omp-extension-guard check --allowlist extensions.allow.json --public-key extension-guard.pub.pem
```

只要有單元是新增、修改、搬移、改名或撤銷的，就以 1 結束並逐一列出；`--scope all` 連使用者層的單元一起查。[`examples/github-check.yml`](examples/github-check.yml) 是一個 workflow 範例。請用 `bin/omp-extension-guard` 執行，不要用 `bun …/omp-extension-guard.ts`：包裝會讓 Bun 從空目錄啟動，被審的 repo 就不能在檢查程式裡執行它的 `bunfig.toml` preload。

### 每台開發者的機器

寫 `~/.config/omp-extension-guard/config.json`（見 [`examples/config.example.json`](examples/config.example.json)）：

```json
{
	"allowlists": ["~/.cache/omp-extension-guard/extensions.allow.json"],
	"publicKeys": ["~/.config/omp-extension-guard/extension-guard.pub.pem"],
	"mode": "trusted",
	"isolation": "warn",
	"passEnv": [],
	"onUnapproved": "ask",
	"auditLog": "~/.local/state/omp-extension-guard/audit.jsonl",
	"omp": ["omp"]
}
```

然後透過啟動器啟動 omp，omp 自己的參數放在 `--` 之後：

```bash
omp-ext-safe -- --model <你的模型>
```

`omp-ext-safe --plan -- …` 會印出什麼會載入、什麼被擋在外面、原因是什麼，但不啟動 omp（會啟動就以 0 結束，不會就以 3 結束）。`omp-ext-safe --help` 列出所有旗標；每個設定欄位都有對應的旗標。結束碼：omp 自己的、用法錯誤 2、拒絕啟動 3。

信任錨點（清單和公鑰）只從這個檔案或旗標來，絕不從環境變數來：Bun 會把專案的 `.env` 載入在該專案啟動的行程。

### 模式

- `trusted`（預設）：每個核准的 extension 進入點和 guard 都用 `--trusted-extension` 指名。omp 會關掉所有自動發現，任何一支載入失敗就中止。它不能和 `-e` 並用，所以啟動器會把你的 `-e` 參數換成核准的進入點，或拿掉。
- `explicit`：`--no-extensions` 加 `-e`。載入的集合一樣，但某支載入失敗時 omp 不會中止。
- `discovery`：保留自動發現；overlay 把 `extensions:` 換成核准的進入點，並把每個沒核准的單元列進 `disabledExtensions`。沒核准的單元沒有 id（TypeScript 指令），或和核准的單元共用 id，就拒絕啟動。

每種模式下，沒核准的自訂工具都用 `tool:<名稱>` 關掉；沒核准的 plugin 工具會讓啟動器拒絕啟動。核准的 TypeScript 指令在 `trusted` 和 `explicit` 模式下不會載入。

### 憑證與隔離

omp 拿到的環境變數是 `DEFAULT_PASS_ENV`（`PATH`、`HOME`、語系、終端機、暫存、XDG、`PI_CODING_AGENT_DIR`）加上 `passEnv`。`isolation` 決定還碰得到的真憑證怎麼處理：名稱或格式像金鑰的變數、omp 參數裡的憑證、`~/.git-credentials`、`~/.config/gh/hosts.yml`、`~/.aws/credentials`、SSH 金鑰之類的檔案，以及 omp 的 `agent.db` 裡存了憑證的 provider。

- `warn`（預設）印出來；`require` 拒絕啟動；`off` 不檢查。
- 值等於 `placeholder`（預設 `proxy-managed`）的，是憑證代理放在金鑰位置的代位值，可以通過。
- `accept` 用 key 列出你刻意保留的暴露：`env:CURSOR_API_KEY`、`file:~/.netrc`、`store:anthropic`。

結果只寫位置，不寫值。沒有憑證代理時，omp 需要的 provider 金鑰一定碰得到 omp 載入的程式碼；`require` 是讓這件事看得見，而不是藏起來。

### 在沙箱裡用

真正的界線在行程外：容器或 microVM、只掛專案目錄、omp 狀態每個專案一份、不掛主機的 `~/.omp` 和 `~/.config/gh`、對外流量經允許清單代理、金鑰由代理持有並代為注入。社群的 [omp-sbx](https://github.com/mikeatlas/omp-sbx)、[omp-sandbox](https://github.com/nmarcetic/omp-sandbox)、[omp-guard](https://github.com/bnivanov/omp-guard) 做的就是這件事；這個套件沒有和它們一起測過。在沙箱裡執行 `omp-ext-safe --isolation require`，清單和公鑰用唯讀掛載；用完銷毀沙箱，並撤銷用過的金鑰，或讓它到期。

### 不用 omp-ext-safe

直接載入 guard（`omp -e <這個套件>`，搭配上面的設定檔），會拿清單檢查工具、擋下寫入啟動位置，但 omp 自動發現的東西照樣先載入、先執行。

## 測試

```bash
bun run test
```

`bun run test` 會用暫存的 `HOME` 和 `TMPDIR` 啟動 Bun；直接打 `bun test` 會被拒絕，因為測試會寫入、刪除使用者層的 fixture，而 Bun 在啟動時就固定了家目錄。測試透過 omp 自己的 discovery、loader、runner 和設定執行，不連網。

Live 測試用測試專用的腳本模型 provider（`test/scripted-provider.ts`）跑真的 omp：

```bash
EXTENSION_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
EXTENSION_GUARD_LIVE_OUT=/tmp/extension-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` 改跑已安裝的 omp。涵蓋：直接跑 omp（repo 的 extension、工具、preload、`.env` 全部執行，extension 讀得到憑證）、`--no-extensions --no-tools`（`.omp/tools` 和 preload 照樣執行）、`omp-ext-safe` 的三種模式（只有核准的 extension 執行，而且讀不到憑證和 `.env`）、它的拒絕情況（沒核准的 plugin 工具、`require` 模式下的憑證）、trusted extension 載入失敗時 omp 中止、guard 擋下植入的程式碼、不經啟動器時 guard 鎖住 session，以及 CI 檢查有沒有經過包裝的差別。

## 公開發布前要做的

- **威脅建模。** 還沒做。清單、啟動器和 guard 的 STRIDE、OWASP LLM Top 10、OWASP Agentic 走查還沒做。
- **安全稽核。** 還沒做。啟動器和 guard 沒有經過獨立的對抗式審查。
- **真模型測試。** 還沒做；開發這台機器沒有網路。
- **第一次 CI。** GitHub Actions workflow 還沒跑過；`bun.lock` 是從 Bun 的快取離線產生的。
- **驗證用沙箱。** 在沒有網路、放假憑證的沙箱裡先跑一次沒審過的 extension，看它讀了什麼、寫了什麼：這是手動步驟，這裡沒有自動化。
- **較新的 omp 版本。** 只測過 18.2.8。

## 限制

- **核准的程式碼仍在 omp 的行程裡執行。** 核准決定什麼載入；核准的 extension 能做 omp 能做的任何事，包括在載入當下。限制它的只有沙箱和憑證代理。
- **guard 看得到結果，看不到動作。** 它會發現沒核准的程式碼註冊的工具；什麼都不註冊、或去改 guard 本身的程式碼，它看不到。不經 `omp-ext-safe` 時，自動發現的程式碼會比 guard 先執行。
- **digest 涵蓋的是單元。** 檔案單元釘住那個檔案，目錄單元釘住目錄裡的一切；指到單元外的 symlink 會讓單元無法核准。從單元外 import 的東西，例如被 hoist 的 plugin 相依套件，不在範圍內；請用 lockfile 釘住。
- **`bash` 和 `eval` 是靜態判讀。** 沒有直接寫出路徑就碰到啟動檔的指令（`find . -exec`、執行時才組出的路徑、另一支 script）看不到。能不給 `bash` 和 `eval` 就別放進 `--tools`。
- **清單可以被重放**，除非設了到期；請用 `--expires-in-days`。
- **檢查和啟動之間**，檔案仍可能被改；omp 載入的是當下磁碟上的內容，而 guard 的啟動檢查只看得到工具。
- **沒涵蓋的：** MCP server（它們是獨立行程，見 Day 27）、skill 內容（Day 20）、shell 啟動檔等 omp 目錄以外的持久化、omp 的 profile（`--profile`），以及 Windows。
- **稽核紀錄在本機**，沒有防竄改。

## 背景

這個套件實作的是 omp 對 Cursor 強化系列 Day 21「extension 跟 omp 本體同一個行程」寫的整合時序圖。那張圖把五個來源排在同一條時序上：文章的開關、上游 omp 的文件與 issue、社群的沙箱包裝、一份 workflow playbook 的隔離與短效憑證，以及一套安全稽核方法的信任擴張審查。這個套件把能在一台機器上跑的部分自動化：盤點與核准、啟動決策、憑證檢查、行程內的 guard，以及 CI 閘門。沙箱、代理和撤銷金鑰留在套件之外。

## 授權

[MIT](LICENSE)
