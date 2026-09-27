# 🚀 CrashPY — el crash paraguayo en tiempo real

Juego **Crash** multijugador en **guaraníes (PYG)** que corre en tu PC y se juega desde el celular a través de **Cloudflare Tunnel**.
Incluye resultados **comprobables (provably fair)**, **chat**, **depósitos y retiros por transferencia** y un **panel de administración en tiempo real**.

![CrashPY](public/img/icon-192.png)

## ✨ Qué trae

**Para los jugadores**
- Cohete con animaciones, estelas, explosión, sonidos y vibración en el celular.
- Multiplicador en tiempo real (2x ≈ 11,5 s, 10x ≈ 38 s) y **retiro en cualquier momento**.
- **2 apuestas por ronda**, **retiro automático** (funciona aunque se corte internet) y **apuesta automática**.
- Apuestas en vivo de todos, historial de rondas, "Mis apuestas", **Top ganadores** del día / semana / mes.
- **Chat** con emojis, anuncios del admin y avisos automáticos de ganancias grandes.
- **Billetera**: depositar por transferencia (con foto del comprobante), retirar a cualquier banco o billetera, movimientos y estado de solicitudes.
- Se puede **instalar como app** en el celular ("Agregar a pantalla de inicio").
- Página **/fair** para verificar cualquier ronda (SHA-256), sin depender del servidor.

**Para el administrador (`/admin`)**
- Tablero en vivo: conectados, qué apuesta cada uno, ganancia de la casa por hora/día, actividad.
- **Ronda en vivo** con todas las apuestas, botón **💥 Explotar ahora** y **⏸ Pausar / ▶ Reanudar**.
- **Usuarios**: buscar, ver ficha completa, **editar saldo** (sumar / restar / fijar), suspender, silenciar en el chat, cambiar contraseña, cuentas con la misma IP.
- **Depósitos** (con foto del comprobante) y **retiros** (con datos bancarios para copiar): aprobar / rechazar con un toque. Avisos con sonido.
- **Chat**: borrar mensajes, silenciar, anuncios.
- **Configuración**: apuestas mínimas/máximas, ganancia máxima, tiempo para apostar, datos bancarios, WhatsApp de soporte, bono de bienvenida…
- **Auditoría**: todo lo que hace cada admin queda registrado. **Libro contable**: cada guaraní que entra o sale queda anotado.
- **Respaldos** automáticos de la base de datos cada 6 horas y descarga manual.

---

## 🖥️ Instalación en Windows (paso a paso)

1. **Instalá Node.js** (versión **LTS**, 22.13 o superior) desde <https://nodejs.org>. Siguiente → Siguiente → Instalar.
2. **Descargá este proyecto** (botón verde *Code → Download ZIP* en GitHub) y descomprimilo, por ejemplo en `C:\CrashPY`.
3. Hacé **doble clic en `INICIAR.bat`**.
   - La primera vez instala lo necesario (tarda un minuto).
   - En la ventana aparece el **usuario y contraseña del administrador** (también queda guardado en `data\ADMIN-INICIAL.txt`).
   - Si Windows pregunta por el firewall, tocá **Permitir acceso**.
4. Abrí en el navegador **<http://localhost:3000>** para jugar y **<http://localhost:3000/admin>** para el panel.
5. En el panel entrá a **Configuración** y cargá tus **datos bancarios** (banco, titular, CI/RUC, cuenta, alias) — eso es lo que ven los jugadores al depositar. Cambiá también la contraseña del admin.

> Si querés elegir vos la contraseña del admin antes del primer arranque, copiá `.env.example` como `.env` y completá `ADMIN_PASS=`.

### Probar desde el celular en tu casa (misma WiFi)
Cuando arranca, la ventana muestra una línea **"En tu WiFi (cel): http://192.168.x.x:3000"**. Abrí esa dirección en el celular.

---

## 🌐 Jugar desde internet con Cloudflare Tunnel

Cloudflare Tunnel conecta tu PC con internet **sin abrir puertos en el router** y con **HTTPS** automático.

### Opción A — Rápida (sin cuenta, dirección temporal)
1. Instalá `cloudflared`: abrí **PowerShell** y ejecutá
   ```
   winget install --id Cloudflare.cloudflared
   ```
   (o descargá `cloudflared-windows-amd64.exe` desde <https://github.com/cloudflare/cloudflared/releases/latest>, renombralo a `cloudflared.exe` y ponelo en la carpeta de CrashPY).
2. Con `INICIAR.bat` abierto, hacé doble clic en **`TUNEL-CLOUDFLARE.bat`**.
3. Aparece una dirección tipo **`https://palabras-al-azar.trycloudflare.com`** → esa es la que compartís y abrís en el celular.

⚠️ Esa dirección **cambia cada vez** que abrís el túnel. Sirve para probar; para el día a día usá la opción B.

### Opción B — Permanente (tu propio dominio, ej. `crashpy.com.py`)
Necesitás una cuenta gratis en Cloudflare y un dominio agregado a Cloudflare.

**Desde el panel web (más fácil):**
1. Entrá a <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel** → tipo *Cloudflared* → ponele de nombre `crashpy`.
2. Elegí **Windows** y copiá el comando que te muestra (`cloudflared.exe service install eyJ...`). Ejecutalo en **PowerShell como administrador**: queda instalado como servicio y arranca solo con Windows.
3. En **Public Hostname** agregá: *Subdomain* `juego` (o vacío), *Domain* tu dominio, *Service* `HTTP` → `localhost:3000`.
4. Listo: el juego queda en `https://juego.tudominio.com` y el panel en `https://juego.tudominio.com/admin`.

**Desde la consola (alternativa):**
```
cloudflared tunnel login
cloudflared tunnel create crashpy
cloudflared tunnel route dns crashpy juego.tudominio.com
```
Después creá el archivo `C:\Users\TU_USUARIO\.cloudflared\config.yml`:
```yaml
tunnel: crashpy
credentials-file: C:\Users\TU_USUARIO\.cloudflared\ID-DEL-TUNEL.json
ingress:
  - hostname: juego.tudominio.com
    service: http://localhost:3000
  - service: http_status:404
```
y arrancalo con `cloudflared tunnel run crashpy` (el archivo `.json` lo crea el paso `tunnel create`).

> Los WebSockets (tiempo real) funcionan con Cloudflare sin configurar nada extra.
> Recomendado: en Cloudflare activá **"Always Use HTTPS"**.

---

## 💸 Cómo funciona la plata

Todo se maneja en **guaraníes enteros** y **cada cambio de saldo queda en el libro contable** (tipo, monto, saldo resultante, quién lo hizo y por qué).

**Depósito**
1. El jugador toca **Depositar**, ve tus datos bancarios y transfiere desde su banco o billetera.
2. Completa el monto, el número de comprobante y sube la **captura**.
3. Te aparece en **Admin → Depósitos** con aviso sonoro. Revisás tu cuenta y tocás **Aprobar** (podés corregir el monto) o **Rechazar** con un motivo.
4. Al aprobar, el saldo se acredita al instante y el jugador recibe una notificación.

**Retiro**
1. El jugador pide un retiro con su banco, cuenta/alias, titular y CI. **El monto se descuenta en ese momento** (queda reservado).
2. En **Admin → Retiros** copiás los datos, hacés la transferencia desde tu banco y tocás **Marcar pagado**.
3. Si lo rechazás, **el saldo se le devuelve automáticamente**.

**Ajustes manuales**: en la ficha de cada usuario podés **sumar, restar o fijar** el saldo (por ejemplo, un depósito que te mandaron por WhatsApp). Siempre queda registrado con el motivo.

**Ganancia de la casa**: viene de la **ventaja matemática** (por defecto **3 %**, RTP 97 %, como Aviator). En el largo plazo la casa se queda con ~3 % de todo lo apostado. Además podés limitar:
- **Apuesta máxima** y **ganancia máxima por apuesta** (al llegar al tope se retira sola).

---

## 🔐 Provably fair (juego comprobable)

- Al instalar se genera una **cadena de 1.000.000 de hashes SHA-256** y se publica el **hash terminal** en `/fair` antes de jugar.
- Cada ronda usa el hash anterior de la cadena: `SHA256(hash de la ronda) = hash de la ronda anterior`. Nadie puede saber el próximo resultado ni cambiarlo.
- El punto de explosión sale de una fórmula pública:
  ```
  hmac  = HMAC_SHA256(clave = sal, mensaje = hash)
  X     = primeros 52 bits de hmac / 2^52
  crash = floor((100 − ventaja%) / (1 − X)) / 100     (mínimo 1.00x)
  ```
- Tocando cualquier ronda del historial se ve su hash y se verifica en el mismo celular.
- Para **cambiar la ventaja de la casa**: *Admin → Provably fair → Generar cadena nueva*. Se aplica desde la próxima ronda y la semilla de la cadena vieja se publica.

### 💥 Sobre el botón "Explotar ahora"
El admin puede detener una ronda en vuelo en cualquier momento (por ejemplo si hay un problema). Para que el juego siga siendo **honesto y verificable**, al detenerla elegís:
- **Devolver apuestas**: la ronda se anula y cada jugador recupera lo que apostó.
- **Pagar a todos al multiplicador actual**: todos cobran como si hubieran retirado en ese momento.

La ronda queda marcada como **anulada** en el historial público junto con su hash. Así **nadie pierde plata por una intervención manual** y el sistema sigue siendo comprobable.

> ¿Por qué no hay un botón para "hacer perder" a propósito? Porque con dinero real sería una estafa a los jugadores, y además el sistema de hashes lo delataría: cualquiera podría demostrar que la ronda no coincide con su hash. La ganancia de la casa sale de la ventaja matemática, que es lo que usan todos los casinos serios.

---

## 🛡️ Seguridad y respaldos

- Contraseñas guardadas con **scrypt**; sesiones con cookies `HttpOnly`.
- Límites contra abuso (intentos de login, registros, mensajes, acciones por segundo).
- El punto de explosión **nunca** se envía antes de que la ronda termine.
- Si el servidor se apaga o se corta la luz en medio de una ronda, al volver **la ronda se anula y se devuelven las apuestas**.
- **Respaldos**: se guarda una copia de la base de datos cada 6 horas en `data\backups\` (se conservan los últimos 30). También podés descargar una desde *Admin → Configuración → Respaldos*.
  👉 **Copiá la carpeta `data` a un pendrive o a la nube de vez en cuando.** Ahí está todo: usuarios, saldos, apuestas y comprobantes.
- No compartas la carpeta `data` ni el archivo `.env`.

## 🧰 Problemas comunes

| Problema | Solución |
|---|---|
| "Necesita Node.js 22.13 o superior" | Instalá la versión LTS de <https://nodejs.org> y reiniciá la PC. |
| "El puerto 3000 ya está en uso" | Ya hay otra ventana de CrashPY abierta. Cerrala o cambiá `PORT` en `.env` (y usá el mismo en el túnel). |
| Me olvidé la contraseña del admin | Con el servidor apagado ejecutá `npm run reset-admin -- NuevaClave123` en la carpeta del proyecto. |
| El celular no entra por WiFi | Permití "Node.js" en el Firewall de Windows (Redes privadas) y verificá que estén en la misma red. |
| La dirección trycloudflare cambió | Es normal en la opción rápida. Usá la opción B (dominio propio) para una dirección fija. |

## ⚖️ Aviso legal

Los juegos de azar con dinero real están regulados. En Paraguay la explotación de juegos de suerte o azar requiere autorización de la **CONAJZAR** (Ley N.º 1016/97). Operar sin habilitación puede traer consecuencias legales. Este software se entrega como herramienta; **el cumplimiento de la ley, la verificación de mayoría de edad y el juego responsable son responsabilidad de quien lo opere**. Solo para mayores de 18 años.

---

## 👩‍💻 Para desarrolladores

```
npm install        # dependencias (express, socket.io)
npm start          # servidor en http://localhost:3000
npm run dev        # reinicia solo al guardar cambios
npm test           # pruebas automáticas (apuestas, retiros, saldos, provably fair)
```

- **Servidor**: Node.js + Express 5 + Socket.IO + SQLite integrado (`node:sqlite`, sin compilar nada).
- **Frontend**: HTML/CSS/JS sin frameworks ni build (`public/`), animación en `<canvas>` y sonidos con WebAudio.

```
server/
  index.js        arranque, HTTP, seguridad
  game.js         motor del juego (fases, apuestas, retiros, explosión, controles admin)
  fair.js         cadena de hashes y fórmula del punto de explosión
  wallet.js       saldos, libro contable, depósitos, retiros, ajustes
  sockets.js      tiempo real (jugadores y /admin)
  routes/         API REST pública y de administración
public/
  index.html      juego · admin.html panel · fair.html verificación
  js/ css/ img/
data/             base de datos, comprobantes y respaldos (se crea sola)
```
