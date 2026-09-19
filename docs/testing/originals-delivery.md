# Originals delivery: protocol and evidence

Date of experiment: 2026-09-19. Task: [002](../tasks/002-originals-delivery.md).

## Result in one sentence

The guarded server leg is `PASS` for a synthetic ZIP and a real BIFF8/OLE `.xls`,
including byte equality and independent parsing of the delivered copies. Delivery into
ChatGPT Work is `BLOCKED/INCONCLUSIVE`: this checkout has neither an authenticated ChatGPT
Work session with Developer mode nor a workspace-associated Secure MCP Tunnel. This is not
evidence that ChatGPT cannot deliver the files.

Do not start tasks 003/004 on the strength of the local result alone. Complete the target
trial below first, or deliberately choose and approve another delivery route.

## Target client and route

The selected target is **ChatGPT Work on the web**, in a new Work chat, with a personal
plugin registered in ChatGPT Developer mode. The connection method is **Secure MCP Tunnel**
associated with the same workspace. The tunnel reaches this checkout's stdio command:

```text
ChatGPT Work cloud analysis runtime
  -> installed personal plugin
  -> workspace-associated Secure MCP Tunnel
  -> node dist/index.js --read-only --root-boundary <synthetic-root> <synthetic-root>
  -> filesystem-mcp://file/{+path} resources/read blob
  -> file bytes materialized inside the analysis runtime
```

Authentication is the ChatGPT workspace/tunnel association; no source credential, OAuth
implementation, or filesystem API key is added by this experiment. One-time connection
setup is distinct from per-file work. After setup, a passing run permits no manual download,
upload, base64 paste, or shared-disk read for either original.

The first target trial uses the existing MCP contract only:

1. The assistant finds `unicode-original.zip` and `legacy-original.xls` with `find_files`.
2. The host resolves each path through the advertised
   `filesystem-mcp://file/{+path}` template and calls `resources/read`.
3. The host must materialize those returned blob bytes as files in the ChatGPT analysis
   runtime. A visible URI or model-readable base64 is not success.
4. Code running in that runtime calculates SHA-256 from the materialized files, opens the
   ZIP and reads the XLS control cells.

If ChatGPT exposes tools but does not let this existing resource become an analysis file,
record the observed result as `FAIL` for this route. Only then should planning approve a
small delivery adapter using the target's supported tool file-reference contract. Do not
infer that adapter's contract from the presence of a generic MCP resource link.

### Official documentation checked

Checked on 2026-09-19:

- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
  documents ChatGPT Developer mode and says a private MCP server can be reached with Secure
  MCP Tunnel; the tunnel may reach configured stdio or HTTP MCP.
- [Plugins quickstart](https://developers.openai.com/plugins/quickstart) identifies ChatGPT
  Work on the web as the surface for invoking a personal MCP-backed plugin.
- [Plugin reference: File APIs](https://developers.openai.com/plugins/reference#file-apis)
  documents optional ChatGPT file helpers and temporary download URLs for ChatGPT file IDs.
  It does not state that an arbitrary `resources/read` blob is automatically materialized in
  the analysis runtime. That promotion remains the fact this experiment must observe.

Documentation describes a supported connection mechanism, not the outcome of this task's
byte-delivery path. Actual client evidence is kept separate below.

## Reproducible synthetic fixtures

Generated binaries stay under ignored `.tmp/`; Git contains the generator and both independent
checkers. `xlwt` writes the workbook and `xlrd` reads the delivered copy, so the reader is not
the writer. The `.xls` begins with the OLE Compound File signature
`D0 CF 11 E0 A1 B1 1A E1`; it is not renamed CSV/XLSX.

Fixture contents:

| Artifact               |        Size | Source SHA-256 from Python manifest                                |
| ---------------------- | ----------: | ------------------------------------------------------------------ |
| `unicode-original.zip` |       703 B | `4e729b848906db06641b1ef60e752ae654b5705e92a881cd68319a6538a7fe02` |
| `legacy-original.xls`  |     5,632 B | `db5c5cbd862f422b42085e3ac0936bb200a7a32cdbf3fce503b3bc76f476fc91` |
| `at-limit.bin`         | 1,048,576 B | `fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83` |
| `over-limit.bin`       | 1,048,577 B | `4a18705ec8e46ec271084144d7f83ef989302b82518e509ee23deb9d2e2efed6` |

The generator was run twice into separate scratch directories. The complete manifests were
identical, including all four hashes.

ZIP expectations:

| Entry                    |  Size | SHA-256                                                            |
| ------------------------ | ----: | ------------------------------------------------------------------ |
| `README.txt`             |  41 B | `929dbadce62f1ae81310e4b40fc94d06badb1a01eac196625bcdac87bc95aa85` |
| `data/Größe-Антенна.txt` |  31 B | `aaaff9deeb1303ee5807f82bf3c785f316d2357ac25f79b1a3d96e9adb780a9a` |
| `payload.bin`            | 273 B | `3a5b099d4dd1e2510b9799d8626ac4c4e34f4293ea4683cc60e15ff9d2efdb62` |

XLS expectations:

| Cell          | Expected value              |
| ------------- | --------------------------- |
| `Control!A1`  | `SCHWARZBECK-ORIGINALS-002` |
| `Control!B2`  | `4242`                      |
| `Control!C3`  | `12.5`                      |
| `Control!D4`  | `Größe Антенна`             |
| `Control!E5`  | `2026-09-19T12:34:56`       |
| `Контроль!A1` | `КОНТРОЛЬ-Ω`                |
| `Контроль!B3` | `-7`                        |

## Commands

Run from a clean checkout root in PowerShell. Use Python 3.12 or later. The two pinned packages
are experiment-only and install under ignored scratch; they are not server runtime dependencies.

```powershell
npm ci
$python = "python"
$deps = Join-Path (Get-Location) ".tmp/originals-delivery-pydeps"
& $python -m pip install --disable-pip-version-check --target $deps `
  -r scripts/originals-delivery/requirements.txt
$env:PYTHONPATH = $deps

& $python scripts/originals-delivery/generate_fixtures.py `
  --output .tmp/originals-delivery/source
npm run build
node scripts/originals-delivery/local-mcp-check.mjs `
  --fixture-root .tmp/originals-delivery/source `
  --delivery-dir .tmp/originals-delivery/delivered `
  --max-file-size 1048576
& $python scripts/originals-delivery/verify_delivered.py `
  --manifest .tmp/originals-delivery/source/manifest.json `
  --delivery-dir .tmp/originals-delivery/delivered
```

`local-mcp-check.mjs` starts the built server over real stdio with `--read-only`, an explicit
`--root-boundary`, and a 1 MiB file limit. It calls `resources/read`, decodes the returned blob,
writes only the received bytes to the delivery directory, then calculates source/delivered/repeat
hashes in Node. `verify_delivered.py` receives only the source manifest and delivery directory;
it calculates the delivered hashes again in Python and opens the delivered ZIP/XLS.

## Observed local result

Environment: Windows NT 10.0.19045, PowerShell 7.6.5, Node 24.15.0, npm 11.12.1,
Python 3.12.14, `filesystem-mcp` 2.3.0, `xlwt` 1.3.0 and `xlrd` 2.0.2. MCP negotiated the
modern protocol era. The read-only tool inventory contained the expected seven tools.

| Check                                          | Status                      | Evidence                                                                                                                                                           |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ZIP source -> stdio resource -> delivered copy | `PASS`                      | 703 B at both ends; Node source, delivered and repeated hashes all `4e729b…fe02`; Python delivered hash matched; ZIP CRC and all three entries opened and matched. |
| XLS source -> stdio resource -> delivered copy | `PASS`                      | 5,632 B at both ends; Node source, delivered and repeated hashes all `db5c5c…fc91`; Python delivered hash matched; `xlrd` read all seven control cells.            |
| Exact 1 MiB resource                           | `PASS`                      | 1,048,576 bytes returned and hash matched; observed read 20.0 ms.                                                                                                  |
| 1 MiB + 1 byte resource                        | `PASS` (expected rejection) | MCP `ProtocolError`, code `-32602`: `File exceeds size limit (1048577 > 1048576 bytes)`.                                                                           |
| File outside synthetic root                    | `PASS` (expected rejection) | MCP `ProtocolError`, code `-32602`: outside allowed directories.                                                                                                   |
| Repeat originals                               | `PASS`                      | A second independent `resources/read` of both formats produced the same SHA-256.                                                                                   |

Across two observed runs, the first ZIP read took 8.0-8.7 ms and its repeat 0.0-0.1 ms;
the first XLS read took 2.3 ms and its repeat rounded to 0.0 ms; the 1 MiB boundary read took
16.4-20.0 ms. These are smoke timings, not performance claims.

The file resource has a 5-second cache hint but no expiring file URL and no server-side
resource TTL. Lifecycle expiry is therefore `N/A` for the local route. Cached JSON tool results
have a separate lifetime and are not the originals-delivery mechanism tested here.

## Target result matrix

No authenticated ChatGPT Work page, Developer-mode plugin connection, tunnel identity, or
analysis-runtime file handle was available in this task environment. The only browser surface
exposed to the task was an empty Codex in-app browser. No endpoint was published and no
synthetic bytes were transmitted to a third party.

| Format                 | Target status          | What is still missing                                                                                                                                                                    |
| ---------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP                    | `BLOCKED/INCONCLUSIVE` | Workspace with Developer mode, a workspace-associated Secure MCP Tunnel, installed personal plugin, and a new Work chat that can materialize the resource bytes in its analysis runtime. |
| legacy XLS             | `BLOCKED/INCONCLUSIVE` | Same access; then SHA-256 from the delivered analysis file and cell reads with an independent XLS reader.                                                                                |
| Target limit/lifecycle | `BLOCKED/INCONCLUSIVE` | Repeat at/beyond the target's observed file/reference limit and, if temporary file URLs appear, verify expiry and error text.                                                            |

The block is missing external access/configuration, not an observed platform failure. The
local SDK result must not be relabelled as a target `PASS`.

## Exact target trial to run after access is supplied

1. Associate a Secure MCP Tunnel with the intended ChatGPT workspace and configure it to run
   the stdio command shown above against only `.tmp/originals-delivery/source`.
2. In ChatGPT, enable Developer mode, register the MCP connection through that tunnel, install
   the personal plugin, start a new **Work** chat and select the plugin.
3. Ask it to find the two originals and obtain them through the connector. Record the tool and
   resource calls, arguments, errors, and any file IDs or temporary URLs without recording
   credentials.
4. In the Work analysis runtime, calculate SHA-256 from the actual delivered file paths. Open
   the ZIP, run its integrity check, enumerate/check the expected entries, and open the XLS with
   an independent reader to check the seven cells above.
5. Repeat both downloads. Then test the smallest practical values at and above the target's
   own applicable limit. If the route yields temporary URLs, wait past their stated/observed
   expiry and capture the subsequent error. Keep the test budget small.
6. Count one-time connection actions separately. Per-file manual actions must be zero for
   `PASS`. A user upload, copied base64, common disk, or regenerated fixture is a failed test.

## Recommendation

Planning should keep 003/004 waiting. To finish 002, provide access to the intended ChatGPT
workspace with Developer mode and either an existing Secure MCP Tunnel association or authority
to configure one for this synthetic-only root. If the existing resource contract is observed to
fail, record that `FAIL` and decide separately whether to prototype a bounded tool file-reference
adapter. No snapshot, bundle, OAuth, persistent artifact storage, or server-side XLS parser is
justified by the current evidence.
