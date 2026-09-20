# Windows → ChatGPT: live runbook

Date started: 2026-09-19. Outcome recorded by planning: 2026-09-20. Task: [002-live](../tasks/002-live-windows-chatgpt.md).

This document records only steps actually checked with the user. It is not evidence
of target delivery until ChatGPT Work calculates hashes from files materialized in
its own analysis runtime and opens both formats.

## Current status

- Target host: the current Windows machine used for the guided trial.
- Checkout base: `1cf6ab8da6945f92bf945373432147f427fbd019`.
- Branch: `codex/002-live-windows-chatgpt`.
- Route under evaluation: ChatGPT Work personal plugin through Secure MCP Tunnel
  to the repository's read-only stdio server.
- Target ZIP delivery: FAIL for the existing resource-template contract.
  ChatGPT exposed and called the tools but did not expose `resources/read`, so no
  binary file reached its analysis runtime.
- Target XLS delivery: not attempted because it relies on the same unavailable route.

## Verified preflight

The user ran the read-only preflight on the target host and reported:

| Component        | Observed value                                    |
| ---------------- | ------------------------------------------------- |
| Windows          | Windows 10 Pro 10.0.19045, build 19045, 64-bit    |
| PowerShell       | 5.1.19041.6456, Desktop edition                   |
| Git              | 2.45.1.windows.1                                  |
| Node.js          | 24.15.0                                           |
| npm              | 11.12.1                                           |
| Python           | 3.12.3, 64-bit host path reported by the launcher |
| ChatGPT Work     | visible                                           |
| Developer mode   | visible and enabled                               |
| Personal plugins | creation available; existing plugins are present  |

The host meets the repository's Node.js and Python prerequisites. No credential,
workspace identifier, personal path, or production document is recorded here.

The accepted fork checkout was then verified at the expected base and built on the
target host. `npm ci` installed 241 packages, audited 242 packages with zero reported
vulnerabilities, and `npm run build` completed TypeScript compilation. The resulting
`dist/index.js` existed and was 4,055 bytes. The two working-tree documentation
changes are the expected records for this task.

The user then opened Platform Tunnel settings successfully, confirmed that tunnel
creation/management and ChatGPT workspace association are available, and reported
the Platform-provided download `tunnel-client-v0.0.14-windows-amd64.zip`. This
matches the target host's x64 architecture.

The downloaded archive had SHA-256
`784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5` and contained
`tunnel-client.exe` (21,826,048 bytes), `cloudflared.exe` (39,751,680 bytes),
license/notice files, an SPDX manifest, and a cloudflared manifest. Windows reported
the client as `NotSigned`; therefore the recorded hash identifies the tested download
but is not publisher-signature evidence. The executable nevertheless ran natively on
this host, and both `help quickstart` and `help doctor` returned successfully. The
help output confirms the stdio profile, runtime-key, `doctor --explain`, and foreground
`run` flow needed for this experiment. At this preflight stage, no key, profile, or network tunnel had been created yet.

The live synthetic generator was run with Python 3.12 and experiment-only
`xlrd==2.0.2` / `xlwt==1.3.0` installed under ignored `.tmp`. All four generated
sizes and SHA-256 values matched the accepted manifest exactly:

| Artifact               |      Size | SHA-256                                                            |
| ---------------------- | --------: | ------------------------------------------------------------------ |
| `unicode-original.zip` |       703 | `4e729b848906db06641b1ef60e752ae654b5705e92a881cd68319a6538a7fe02` |
| `legacy-original.xls`  |     5,632 | `db5c5cbd862f422b42085e3ac0936bb200a7a32cdbf3fce503b3bc76f476fc91` |
| `at-limit.bin`         | 1,048,576 | `fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83` |
| `over-limit.bin`       | 1,048,577 | `4a18705ec8e46ec271084144d7f83ef989302b82518e509ee23deb9d2e2efed6` |

Windows PowerShell 5.1 displayed UTF-8 names from `manifest.json` as mojibake when
`Get-Content` was used without `-Encoding UTF8`. The byte hashes remained correct;
the independent Python verifier is still required to prove the Unicode ZIP entries
and XLS cells.

The live local stdio MCP harness and independent Python verifier then completed.
PowerShell 5.1 surfaced the server's expected stderr configuration message as a
`NativeCommandError`, but the process exit status remained successful and both JSON
reports were written. The reports, not the shell's stderr formatting, establish:

- modern MCP protocol and the expected seven read-only tools;
- cache-bypassed first/repeat ZIP hashes all equal to `4e729b...fe02`;
- cache-bypassed first/repeat XLS hashes all equal to `db5c5c...fc91`;
- exact 1 MiB read `PASS`;
- 1 MiB + 1 byte rejected with `ProtocolError` `-32602` and the expected size reason;
- outside-root read rejected with `ProtocolError` `-32602`;
- Python `zipfile` opened and verified all three entries, including
  `data/Größe-Антенна.txt`;
- Python `xlrd 2.0.2` opened the delivered XLS and verified all seven cells.

This is a local synthetic `PASS`, not a ChatGPT target-delivery result.

## Connection bring-up

Official OpenAI documentation confirms that Secure MCP Tunnel can forward to a
private stdio MCP server. Platform tunnel permissions and ChatGPT Developer mode
are independent. Platform settings, create/manage access, workspace association,
the Windows x64 package, and its CLI help have now been observed. The next live
step is creation of a test tunnel endpoint associated with the owning Platform
organization and the target ChatGPT workspace.

The user created the test tunnel endpoint and showed that both the owning Platform
organization and target ChatGPT workspace are associated. The screenshot also
contained account and tunnel identifiers; those values are intentionally not copied
into this repository. The user subsequently created a separate runtime API key;
its value was not shared or recorded.

The first Windows PowerShell 5.1 `init` attempt failed safely during the client's
MCP-command preflight. Passing the absolute Node executable under `C:/Program Files`
inside a nested quoted `--mcp-command` was parsed as executable `C:Program`. This
was a local command-line quoting failure, not a key, tunnel, network, or MCP-server
failure. Inspection confirmed that no partial profile file was written. The retry
uses `node` from `PATH` plus forward-slash absolute entry/root paths with no spaces;
the read-only and root-boundary arguments remain unchanged.

The corrected retry created exactly one local profile under ignored `.tmp`. A
sanitized self-check confirmed that the profile references
`env:CONTROL_PLANE_API_KEY`, does not contain the runtime key value, and includes
`--read-only`, `--root-boundary`, and the synthetic root.

`doctor --explain` then exited 0 and wrote its full report to ignored `.tmp`.
The report passed profile loading, the environment-only control-plane key
reference, tunnel identity, Node executable resolution, the exact read-only MCP
command, and the loopback-only health/UI listener. Network reachability and OAuth
metadata were skipped as expected for a stdio target. The optional Codex control
plugin was also skipped because this experiment targets ChatGPT Work. The next
step is to keep `tunnel-client run` in the foreground and require a successful
control-plane poll before creating the ChatGPT app.

The user started `tunnel-client run` in the foreground. Windows PowerShell 5.1
again wrapped the MCP server's expected stderr configuration message as
`NativeCommandError`; this did not terminate the daemon. An independent health
probe against the configured loopback listener exited 0: `/healthz` returned
`200 live`, `/readyz` returned `200 ready`, and the required control-plane poll
metric was present and healthy. No account, client-instance, or tunnel identifier
from the live log is recorded here.

With the daemon still ready, the user created and connected the personal ChatGPT
Work plugin through the existing tunnel. Tool refresh completed normally, and the
developer-mode plugin view displayed the discovered read-only actions. Connection
and tool discovery are therefore `PASS`; no target file bytes have been requested
yet.

A user-exported ChatGPT transcript then demonstrated live read-only tool routing.
ChatGPT reported the exact synthetic directory tree, obtained the fixture sizes,
read `manifest.json`, and answered a direct `find_files` request with exactly
`legacy-original.xls` and `unicode-original.zip`. This establishes live tool-call
connectivity through the plugin and tunnel. The manifest values are reference data,
not hashes calculated from files in ChatGPT's analysis runtime, so original-byte
delivery remains unproven.

The isolated ZIP-delivery prompt then returned the explicit marker
`ROUTE_FAIL_NOT_MATERIALIZED`. In that fresh ChatGPT Work conversation,
`list_roots` and `find_files` located `unicode-original.zip`, but the host exposed
only the seven registered tools. It did not expose `resources/read` or another
callable interface for the advertised file-resource template. Consequently the
resource was not read, no blob or file reached the analysis runtime, Python was
not run, and no manifest/base64/manual-upload workaround was used. This is a
precise `FAIL` for the selected existing-contract target route, not a transport,
tunnel, discovery, or filesystem-boundary failure. The XLS leg was not attempted
because it depends on the same unavailable resource route.

Runtime API keys and `CONTROL_PLANE_API_KEY` values must remain local and must not
be pasted into chat, logs, or Git.

## Results

| Stage                                            | Status                        | Evidence                                                                                          |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Host prerequisites                               | `PASS`                        | User-reported version output listed above                                                         |
| ChatGPT Work / Developer mode / personal plugins | `PASS`                        | User confirmed all three UI capabilities                                                          |
| Fork install and build                           | `PASS`                        | Expected base/remote; clean `npm ci`; TypeScript build produced `dist/index.js`                   |
| Synthetic fixture generation                     | `PASS`                        | All four sizes and hashes matched the accepted manifest                                           |
| Local stdio MCP ZIP/XLS delivery                 | `PASS`                        | Uncached repeat hashes, limits, root boundary, ZIP entries and seven XLS cells passed             |
| Platform Tunnel access                           | `PASS`                        | Settings opened; create/manage and workspace association are available                            |
| Test tunnel endpoint                             | `PASS`                        | Created with both required associations; identifiers intentionally omitted                        |
| Separate runtime API key                         | `PASS`                        | Value retained by user only; doctor confirmed the environment reference                           |
| First Windows profile init                       | `FAIL` (quoting, recoverable) | `Program Files` executable parsed as `C:Program`; no profile written                              |
| Corrected Windows profile init                   | `PASS`                        | One profile; env key reference only; read-only synthetic root confirmed                           |
| `doctor --explain`                               | `PASS`                        | Exit 0; config, credential reference, executable, command and loopback health listener passed     |
| Foreground daemon readiness                      | `PASS`                        | Health and readiness returned 200; required control-plane poll succeeded                          |
| ChatGPT plugin connection and tool discovery     | `PASS`                        | Personal plugin connected through the tunnel; action refresh completed normally                   |
| ChatGPT live read-only tool calls                | `PASS`                        | Exported transcript shows exact tree, stat/read results and the two expected `find_files` matches |
| Windows tunnel-client package                    | `PASS` (compatibility)        | v0.0.14 amd64 binary ran; quickstart and doctor help available                                    |
| Windows package Authenticode                     | `NOT SIGNED`                  | Archive hash recorded; no publisher signature reported by Windows                                 |
| ChatGPT ZIP byte delivery                        | FAIL (current contract)       | ChatGPT exposed tools but no callable resources/read; no file was materialized                    |
| ChatGPT XLS byte delivery                        | NOT ATTEMPTED                 | Deferred after the ZIP route failure; no independent XLS target result                            |

## Follow-up recommendation

The user authorized the bounded [002-tool delivery follow-up](../tasks/002-tool-delivery.md) on 2026-09-20. It will test a read-only adapter that
returns one guarded synthetic file from a focused tool as a standard tool file
reference/resource link, then repeats the same analysis-runtime proof. It should
reuse `PathGuard`, `GuardedFileSystem`, the size limit, and the existing resource
URI; it must not add public hosting, OAuth, writable access, snapshot/bundle, or
production roots. Official ChatGPT plugin documentation mentions files returned
by tool file references, but does not publish a precise server-side output schema
beyond the documented input and widget File APIs. The implementation contract
must therefore be verified against the current SDK/host rather than invented.

## Teardown

At the last recorded observation, the test plugin, tunnel profile, and foreground
daemon were retained pending the user's choice to retain the reproducible synthetic stand for the proposed adapter
spike or tear it down. Teardown must stop `tunnel-client`, clear the runtime key
from the PowerShell process, and remove or disable the test plugin/tunnel as agreed.
No runtime API key is stored in repository files.
