# Windows VM evidence — v3.0.0 read-only artifact

**Status: not yet run.** This branch was produced on macOS; the Windows 11 VM
test is the human gate scheduled for Thursday. Nothing below has been executed
against a live WhatsApp account, and no chat data appears here.

Run each step in the UTM Windows 11 guest as a **standard user without
administrator rights**, and paste the command plus its output under the step.
Screenshots go beside this file as `windows/evidencia/*.png`.

## Preconditions

- Artifact: `windows/whatsapp-connector-win-readonly-v3.0.0.zip`
- Its hash: `windows/whatsapp-connector-win-readonly-v3.0.0.zip.sha256`
- Portable Node: the `win-x64` zip pinned in `windows/NODE-VERSION`
- A test phone number (SIM or a Rewired test number) — **never** the personal
  number. Danny picks it.

## Steps

### 1. Unpack into `%LOCALAPPDATA%`

```bat
set ROOT=%LOCALAPPDATA%\System3\whatsapp\3.0.0
mkdir "%ROOT%"
tar -xf node-v24.21.0-win-x64.zip -C "%ROOT%" --strip-components=1
tar -xf whatsapp-connector-win-readonly-v3.0.0.zip -C "%ROOT%"
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" version
```

Expected: exit 0 and `{"version":"3.0.0","contrato_bandeja":1,"readonly":true}`.
Confirm no UAC prompt appeared at any point.

### 2. Link with a pairing code

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" link --code <telefono-de-prueba-E164>
```

Expected: a `codigo_de_emparejamiento:` line, then exit 0 once the phone accepts
it. (The QR path, `link --qr`, writes a PNG to `%ROOT%\.pair\qr.png`.)

### 3. List chats

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" chats --json
```

Expected: a JSON array of `{jid, nombre, es_grupo, ultimos_mensajes}`.

### 4. Set the allow-list

```bat
echo {"jids":["<jid-de-prueba>"]} > allow.json
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" allow --set allow.json
```

### 5. Sync once

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" sync-once --bandeja "%USERPROFILE%\wa-tray"
dir "%USERPROFILE%\wa-tray"
```

Expected: one `.txt` per permitted chat, a document `.pdf` beside it, and
`contrato.json` containing `"contrato": 1`. Chats not in the allow-list are
absent.

### 6. Status

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" status --json
```

Expected: `vinculado: true`, a non-null `ultima_sync`, `pendientes` counting
down to 0 after the sync.

### 7. Prove read-only

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" send --to x --text y
node check-readonly.mjs whatsapp-connector-win-readonly-v3.0.0.zip
```

Expected: `send` is not a command (exit 2); `check-readonly` exits 0.

### 8. Logout

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" logout
```

Expected: exit 0, `vinculado: false`, and `%ROOT%\baileys_auth` removed.

## Sign-off

| Item | Result | Evidence |
|---|---|---|
| No step requested administrator | ☐ | |
| `version` reports the contract | ☐ | |
| `link --code` succeeded | ☐ | |
| `sync-once` wrote tray + document + `contrato.json` | ☐ | |
| Non-permitted chats absent | ☐ | |
| `check-readonly` passes | ☐ | |
| `send` does not exist | ☐ | |

No chat content is recorded in this file or in the screenshots.
