# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) · Versionado: [SemVer](https://semver.org/lang/es/)

## [2.8.1] — 2026-09-05

### Corregido
- **`DRIFT_DETECTED` dejaba de enviar por culpa de una red inestable.** La regla era
  «muchas reconexiones **Y** cero envíos exitosos», y ese invariante es falso: cero
  envíos exitosos casi siempre significa que **nadie intentó enviar**, no que enviar
  esté roto. Observado el 5-sep: cinco reconexiones por timeouts de red (códigos
  408/405), nadie enviando, y el daemon se puso a rechazar salientes mientras la
  recepción funcionaba perfectamente (447 entrantes de 29 contactos ese día).

  La deriva ahora exige **evidencia positiva** de que los mensajes no pasan:
  `decryptFail1h >= 30`, o silencio de entrada de 18h o más con la ventana de 24h
  ya observada. Es la misma clase de error que motivó todo el trabajo de
  observabilidad de la v2.5.0 — confundir ausencia de evidencia con evidencia de
  fallo — y había sobrevivido dentro de la propia máquina de estados.
- **Estado `UNSTABLE` nuevo** para el caso de muchas reconexiones sin evidencia de
  fallo. Se reporta (WARN en el doctor) pero **no bloquea envíos**: castigar al
  usuario por una red con hipo no arregla nada.

## [2.8.0] — 2026-09-05

Hallazgos de la revisión de productización de 3 expertos (Adam Wiggins, Mitchell
Hashimoto, Mike McQuaid) previa a publicar. 20 confirmados, 3 bloqueantes.

### Corregido — BLOQUEANTES
- **`python` → `python3` en todas partes.** El hook de auto-recuperación proactiva y
  la skill invocaban `python`, que **no existe en un macOS de fábrica** desde 12.3.
  La función estrella de auto-reparación estaba muerta al llegar para cualquiera con
  un Mac limpio.
- **El instalador escribe un `.gitignore` dentro del vault.** Ponía `baileys_auth/`
  —la credencial que autentica la máquina COMO tu WhatsApp—, el message store, los
  logs y ~80 MB de `node_modules` dentro del directorio de notas del usuario, sin
  ningún ignore ahí. Un `git add -A` en un vault versionado publicaba las llaves.
- **El daemon ya no puede sobrescribir una conversación existente.** `resolveFilePath`
  hacía `writeFileSync` incondicional cuando el jid no estaba en el índice. Combinado
  con el punto siguiente, un usuario nuevo con la configuración por defecto perdía el
  historial de sus grupos en el primer mensaje. Ahora adopta el archivo si es la misma
  conversación, y si no, escribe a un nombre nuevo y avisa.

### Corregido — otros
- **`sync.mjs` escribe `jid:` para grupos**, no `phone:`. El índice del daemon mapea
  `phone:` a `<dígitos>@s.whatsapp.net`, que nunca coincide con un `@g.us` real, así
  que los grupos exportados eran invisibles para el índice.
- **`install.sh` pasa `WA_INBOX_SUFFIX` a `sync.mjs`**; sin eso el export de historia
  ignoraba la opción que el propio instalador acababa de ofrecer.
- **`send.mjs` y `send-document.mjs` se niegan a correr con el daemon vivo.** Abrían
  su propia sesión Baileys sobre el mismo `baileys_auth/`: dos procesos escribiendo
  el mismo estado Signal es una vía directa a la deriva de sesión.
- **El launcher del MCP transporta la configuración.** Claude Code lo lanza con un
  entorno vacío, así que sin `WA_INBOX_SUFFIX` el servidor MCP resolvía nombres mal.
- **Una sola versión.** `wa-fix.py` se anunciaba como v0.1.0 mientras el paquete iba
  en 2.x; ahora la toma de `package.json`.
- **Las alertas ya no le atribuyen al lector estadísticas del vault del autor.** El
  «16.9h» es la referencia con la que se calibró, y ahora lo dice así.
- **README**: el socket ya no se documenta en `/tmp` (se movió en v2.6.0), y la
  desinstalación ahora explica que **no** borra las credenciales, con los pasos para
  hacerlo y para desvincular el dispositivo desde el teléfono.

## [2.7.0] — 2026-09-05

Preparación para publicar el repositorio. Cambios de contrato, no cosméticos.

### Corregido — BLOQUEANTES para cualquiera que no sea el autor
- **El destinatario de alertas ya no está quemado.** `wa-watchdog.sh` traía el correo
  personal del autor como valor por defecto: quien instalara esto sin configurar nada
  le mandaba SUS alertas de caída a la bandeja del autor, y el canal se veía
  configurado sin estarlo. Ahora no hay destinatario por defecto.
- **El canal de alerta ya no depende del vault del autor.** Antes invocaba
  `⚙️ Meta/scripts/gmail/gmail-send.mjs`, un script que solo existe en la máquina del
  autor — así que en una instalación nueva la función estrella de la v2.5.0
  silenciosamente no hacía nada. Ahora es configurable: `WA_ALERT_COMMAND` (comando
  arbitrario), `ALERT_EMAIL` con `WA_MAIL_SENDER`/`mail`/`sendmail`, y la notificación
  local solo como último recurso.
- **Las variables de alerta viajan en el plist del vigilante.** launchd no hereda el
  entorno del shell, así que exportarlas en `.zshrc` no hacía nada. `install.sh` las
  pregunta y `update.sh` las preserva.
- **El cuerpo del correo pasó a inglés**, como el resto del repositorio.

### Añadido
- **Chequeo `alert-channel`** (17 chequeos en total). Un detector que avisa a ninguna
  parte reproduce exactamente el fallo que este proyecto existe para evitar, así que
  la ausencia de canal es un hallazgo, no una nota al pie.
- **`wa-watchdog.sh --test-alert`** para probar la escalación antes de necesitarla.
  Lee la configuración del plist, no del shell, para que el simulacro ejercite el
  mismo camino que usará el job programado.
- **README reescrito** con gancho, diagrama, **los riesgos por delante** (Baileys es
  no oficial y pueden banear la cuenta; las conversaciones quedan en texto plano;
  `baileys_auth/` es una credencial), declaración de alcance de lo que NO hace, y
  estado alfa honesto.
- **SECURITY.md** con el inventario de activos, los controles, y los huecos conocidos
  declarados en vez de dejados para que el usuario los descubra.
- **CONTRIBUTING.md** con la regla de no commitear identificadores reales y el hook.
- **Plantillas de issue** que piden `doctor --json` y obligan a separar envío de
  recepción, porque fallan de forma independiente.

## [2.6.0] — 2026-09-05

Los 24 hallazgos restantes del panel de 5 expertos (12 P1, 12 P2).

### Seguridad
- **`process.umask(0o077)`** en `daemon.mjs`. Baileys reescribe las llaves Signal
  cada pocos minutos con `writeFile` sin modo, así que nacían 0644 y un `chmod`
  reactivo no podía ganarle: el 5-sep un chmod de 145 llaves se deshizo en minutos.
- **El socket IPC sale de `/tmp`** (modo 1777, alcanzable por cualquier proceso de
  la máquina) a un directorio `.run/` 0700. Aceptaba `send` sin autenticar.
- **Los artefactos de emparejamiento salen de `/tmp`** a `.pair/` 0700, y el QR
  —una credencial viva— se borra al terminar en vez de quedarse para siempre.
- **El chequeo de permisos abarca todo el inventario de secretos**, no solo
  `baileys_auth/`: encontró **11.541 archivos** laxos en los almacenes de mensajes,
  el estado y los respaldos históricos. Antes miraba un solo directorio.
- **`secret-perms` pasa de WARN a FAIL.** Como advertencia no podía disparar
  ninguna alerta, porque `doctor` salía 0 con advertencias.
- **`repair` endurece y poda**: el respaldo nace 0700, se excluye de Time Machine,
  y se conservan solo los 2 más recientes.

### Corregido
- **La cadena de reconexión podía morir para siempre.** Tras dos fallos seguidos el
  `catch` interno se tragaba el error sin reprogramar, y el proceso quedaba vivo con
  heartbeat fresco: watchdog, doctor y `ps` lo llamaban sano. Ahora hay un supervisor
  single-flight que SIEMPRE reprograma.
- **`connect()` se reentraba sin destruir el socket anterior**, dejando escuchas
  huérfanas que inflaban el contador de reconexiones del que se deriva DRIFT_DETECTED.
- **La rotación de log usaba `rename` con el descriptor abierto**, así que el daemon
  seguía escribiendo al inodo renombrado y la ruta canónica no existía nunca. Ahora
  es copy-truncate, con 5 generaciones fechadas en vez de una sola destruida por ciclo.
- **`run-daemon.sh` ya no renombra el stderr al arrancar** — launchd abre el archivo
  y entrega el descriptor ANTES de que el script corra, así que el `mv` dejaba la ruta
  canónica vacía. Esa es la causa de que `session-keys` devolviera "clean slate".
- **`sync.mjs` ya no sobrescribe el histórico del vault.** Es el paso documentado de
  recuperación y podía destruir el registro de lo que se perdió; ahora escribe al lado.
- **`whatsapp_send` ya no adivina un nombre ambiguo**: devuelve los candidatos y no
  envía. Enviar al contacto equivocado no se deshace.

### Añadido
- **`doctor --json`** con `verdict` y `escalate` (`none|fix|repair`), y códigos de
  salida discretos (0/1/2/3/4). La skill lee un campo en vez de reconstruir el
  criterio con regex sobre prosa alineada en columnas.
- **Chequeo `daemon-state`**: la skill mandaba buscar `DRIFT_DETECTED` en una salida
  donde esa cadena no podía aparecer. Ahora existe.
- **Chequeo `key-inventory`**: backlog de pre-keys y conteo de sesiones, el mejor
  indicador adelantado que ya estaba en disco (13.357 sesiones antes del re-pair
  contra 94 después).
- **`session-keys` lee la señal en proceso**, no un grep del log. Medido: el grep
  contaba 44 donde los mensajes realmente no descifrados eran 8, porque contaba
  líneas de traza. Ahora es una tasa por hora con umbral 5/h WARN, 30/h FAIL.
- **Catálogo de desconexión** deliberadamente corto: solo 515 y 440 cambian el
  comportamiento. Una tabla completa fue refutada con datos — julio, un mes sano de
  18.900 mensajes, tuvo 337 cierres `500 badSession`.
- **`whatsapp_daemon_status` responde con un veredicto en la primera línea** y
  `isError: true` cuando está sordo, para que un agente no pueda leerlo como sano.
- **Dead-man en `pipeline-watchdog.sh`**: si `.wa-health.jsonl` deja de crecer 3h, eso
  es una alarma. El silencio nunca es salud.

## [2.5.0] — 2026-09-05

Un apagón de recepción de 28 días (8-ago → 5-sep-2026) no fue detectado por
ninguno de los 13 chequeos existentes. El daemon reportó `connected=true` todo
el tiempo, envió mensajes a diario, y `doctor` — ejecutado el día 25 — imprimió
`12 passed, 0 failed`. Esta versión existe para que eso no pueda repetirse.

### Añadido
- **Separación de señales entrante/saliente en `daemon.mjs`.** `lastInboundRealAt`
  se mueve SOLO con un mensaje de un tercero. Los ecos del propio teléfono y los
  auto-envíos van a `lastOwnEchoAt`. Se publican además `inboundReal24h`,
  `inboundRealJids24h`, `decryptFail1h/24h` y `signalWindowComplete`.
- **Captura de fallos de descifrado Signal** vía `messageStubType === 2`, la señal
  más temprana de deriva de sesión: en el incidente de agosto habría disparado
  dentro de la primera hora. El código anterior la descartaba en `if (!text) continue`.
- **Chequeo `inbound-freshness` en `wa-fix.py`**, primero de la lista y único con
  poder de veto sobre un veredicto sano. WARN a 9h, FAIL a 18h. Umbrales derivados
  de 219 días de la bandeja real (158.818 entrantes): el hueco legítimo más largo
  jamás medido fue 16,9h, así que 18h da cero falsos positivos sobre el histórico.
- **Estado `UNKNOWN`.** La ausencia de evidencia ya nunca es PASS. El chequeo
  `session-keys` devolvía `PASS "clean slate"` de forma permanente porque
  `run-daemon.sh` renombra el archivo de stderr mientras launchd conserva el
  descriptor abierto, así que la ruta canónica no existe nunca.
- **`wa-watchdog.sh` pasa de vigilante de viveza a detector con voz**: evalúa la
  recepción y escala por correo + notificación de macOS, con cooldown de 6h,
  re-alerta al cambiar el cuadro, y silenciamiento con caducidad forzosa de 7 días.
  Nunca alerta por WhatsApp: hacerlo escribe en la bandeja que el detector lee.
- **`.wa-health.jsonl`**, una línea por corrida, como fuente del dead-man.
- **Presupuesto de remediación**: >6 reinicios/24h avisa, >10 abre el circuito.
  En julio hubo 1.954 reinicios en 4 días sin una sola salida humana.
- **`WA_INBOX_SUFFIX`** — sufijo de nombre de archivo configurable. Antes era una
  edición local no versionada que `update.sh` habría sobrescrito, bifurcando cada
  conversación en dos archivos. `update.sh` ahora lo preserva leyéndolo con
  `plistlib` (PlistBuddy se come el espacio inicial).

### Cambiado
- El watchdog manda `SIGTERM` y espera 10s antes de `SIGKILL`: el daemon tiene
  manejador que persiste estado y libera el lock, y nunca se le daba la oportunidad.
- `STALE_SECONDS` de 90 a 300, unificado con `wa-fix.py`.
- Detección de suspensión: si pasaron más de 30 min entre corridas, no se reinicia
  el daemon y se suprime la evaluación de sordera 15 minutos.
- El PID sale de `.daemon.lock` validado contra el nombre del proceso, no de
  `pgrep -f daemon.mjs`, que coincide con cualquier línea de comandos.
- La señal entrante se persiste en `.daemon_state.json`: sin eso el reloj de
  silencio se reiniciaba en cada reinicio del watchdog y nunca llegaba a 18h.

### Eliminado
- `lastMessageAt`. Se escribía desde la ruta de envío Y la de recepción, así que
  los recordatorios que el propio vault se manda lo mantuvieron fresco durante los
  28 días de sordera. Se borra en vez de reinterpretarse: mientras exista, alguien
  lo va a volver a usar.

## [2.4.1] — 2026-09-05

Republicado desde un árbol nuevo. La historia anterior (7 commits, 2026-05-21 → 2026-05-31)
fue eliminada de forma deliberada y **no se puede recuperar desde este repositorio**.

### Seguridad
- **Eliminados identificadores reales de WhatsApp de terceros** que estaban presentes en
  todos los commits de la historia anterior: dos números de teléfono personales
  (`scripts/send.mjs`, `scripts/download_wa_photo.mjs`), un ID de grupo real
  (`scripts/send-document.mjs`) y dos nombres propios usados como ejemplo.
  Ninguna de esas personas consintió su publicación. Reescribir la historia no bastaba
  (GitHub conserva objetos huérfanos accesibles por API), así que el repositorio se
  eliminó y se recreó sin historia.
- `scripts/download_wa_photo.mjs` ya no lleva un JID ni una ruta de salida quemados:
  ahora los toma de `process.argv`.
- **Nuevo `scripts/hooks/pre-commit`**: bloquea cualquier commit que contenga un JID de
  WhatsApp o un número internacional con pinta de real. Instalar con
  `ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit`.

### Nota
Este es el mismo código funcional que la v2.4.0. No hay cambios de comportamiento.

[2.4.1]: https://github.com/danilobrando/whatsapp-vault-connector/releases/tag/v2.4.1
