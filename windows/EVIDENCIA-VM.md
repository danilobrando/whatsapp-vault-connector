# Windows VM evidence — v3.0.0 read-only artifact

**Status: not yet run.** This branch was produced on macOS; the Windows 11 VM
test is the human gate. Nothing below has been executed against a live WhatsApp
account, and no chat data appears here.

Run each step in the UTM Windows 11 guest as a **standard user without
administrator rights**, and paste the command plus its output under the step.
Screenshots go beside this file as `windows/evidencia/*.png`.

## Preconditions

- Artifact: `windows/whatsapp-connector-win-readonly-v3.0.0.zip`
- Its hash: `windows/whatsapp-connector-win-readonly-v3.0.0.zip.sha256`
- Portable Node: the `win-x64` zip pinned in `windows/NODE-VERSION`
- The repository's `scripts/check-readonly.mjs` and `scripts/lib/zip.mjs` for the
  read-only gate
- A test phone number (SIM or a Rewired test number) — **never the personal
  number**. Danny picks it.

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
The default connector state is `%ROOT%\state`; the program and Node remain at
`%ROOT%`. Confirm no UAC prompt appeared at any point.

### 2. Link with a pairing code

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" link --code <telefono-de-prueba-E164>
```

Expected: one JSON line containing `codigo_emparejamiento`, then exit 0 once the
phone accepts it. `link --qr` renders only in the terminal and purges
`%ROOT%\state\.pair` on success, error, or expiry.

### 3. List the complete chat inventory

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" chats --json
```

Expected: one JSON line containing a non-empty array whose every item has exactly
`jid`, `nombre`, and `es_grupo`. This command does not apply the allow-list and
does not fetch message text or attachments.

### 4. Set the allow-list

```bat
echo {"jids":["<jid-de-prueba>"]} > allow.json && "%ROOT%\node.exe" "%ROOT%\win\cli.mjs" allow --set allow.json
```

Expected: one JSON line with the number of allowed JIDs. Groups remain excluded
unless their JID is explicitly listed.

### 5. Sync once into the new tray layout

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" sync-once --bandeja "%USERPROFILE%\wa-tray"
```

Expected: one JSON line with `messages > 0`, `contrato.json` containing
`contrato: 1`, and one or more opaque 16-hex-character chat folders. Each chat
folder contains `chat.json` (`jid`, `nombre`, `tipo`) and a fresh
`lote-<AAAAMMDDTHHMMSSZ>-<n>` containing `chat.txt`, `lote.json`, and document
attachments. A second `sync-once` must create a second lote without replacing
the first. Disallowed chats are absent.

### 6. Status

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" status --json
```

Expected: one JSON line with exactly `vinculado`, `cuenta_enmascarada`,
`ultima_sync`, and `pendientes`; after the sync, `ultima_sync` is non-null and
`pendientes` is 0.

### 7. Prove read-only

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" send --to x --text y >nul 2>&1 & if not errorlevel 2 exit /b 1 & node check-readonly.mjs whatsapp-connector-win-readonly-v3.0.0.zip
```

Expected: the unknown `send` command exits 2 and does not create state;
`check-readonly` exits 0. The checker also verifies the dependency manifest,
including the legitimate `sender*.js` files from Baileys and `ws`.

### 8. Logout

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" logout
```

Expected: one JSON line with `vinculado: false`; `%ROOT%\state\baileys_auth`
is removed and `%USERPROFILE%\wa-tray` remains untouched.

### 9. Uninstall state only

```bat
"%ROOT%\node.exe" "%ROOT%\win\cli.mjs" uninstall --yes
```

Expected: one JSON line; `%ROOT%\win`, `%ROOT%\node.exe`, and the tray still
exist. The product's Python launcher removes the program tree after this
process exits.

## Sign-off

| Item | Result | Evidence |
|---|---|---|
| No step requested administrator | ☐ | |
| `version` reports the contract | ☐ | |
| `link --code` succeeded and pair files were purged | ☐ | |
| Complete inventory has metadata only | ☐ | |
| `sync-once` wrote chat metadata, lotes, document and `contrato.json` | ☐ | |
| Two lotes survived two syncs | ☐ | |
| `check-readonly` passes | ☐ | |
| `send` does not exist | ☐ | |
| `uninstall` kept program, Node and tray | ☐ | |

No chat content is recorded in this file or in the screenshots.
