# Noir Studio · Hosting privado

Servidor de archivos privado para acceder a este computador desde cualquier otro, por internet, con usuarios, contraseñas y conexión HTTPS.

## Puesta en marcha

1. Doble clic en **`INICIAR.bat`**.
2. La ventana muestra la dirección pública (por ejemplo `https://palabras-al-azar.trycloudflare.com`), que **se copia sola al portapapeles**.
3. Ábrela en el navegador. **La primera vez** verás la pantalla *Primer inicio*: crea tu **usuario y contraseña de administrador**.
   - Si lo haces desde **otro computador**, te pedirá el **código de configuración** que aparece en la ventana del servidor. Así nadie más puede adueñarse del hosting.
4. A partir de ahí, entra con tu usuario y contraseña.

> Deja la ventana abierta mientras uses el hosting. Al cerrarla, el acceso se corta. Si el servidor falla, se reinicia solo.
>
> ¿Perdiste el código de configuración? Está en `data/codigo-configuracion.txt` hasta que se crea la primera cuenta.

## Qué incluye

| Sección | Qué puedes hacer |
|---|---|
| **Archivos** | Subir archivos y carpetas (botón o arrastrar), crear carpetas, renombrar, mover, copiar, descargar (carpetas como ZIP), vista previa de imágenes, video, audio, PDF y texto. Clic derecho para el menú de opciones. Arrastra archivos sobre una carpeta para moverlos. |
| **Búsqueda** | Escribe en el buscador para filtrar la carpeta; pulsa **Enter** para buscar en todas las carpetas. |
| **Compartidos** | Enlaces públicos de descarga para quien no tiene cuenta, con caducidad, contraseña y límite de descargas opcionales. |
| **Papelera** | Lo eliminado va aquí y se puede restaurar. Se vacía sola tras 30 días (configurable). |
| **Código** | Explorador de los proyectos que estás desarrollando: árbol de carpetas, resaltado de sintaxis, búsqueda por nombre o contenido, últimos commits de Git y descarga en ZIP. Solo lectura; `.env`, claves y `node_modules` se ocultan siempre. El administrador añade proyectos con la ruta de su carpeta. |
| **Bases de datos** | Sube bases SQLite (.db, .sqlite), volcados .sql, CSV o JSON. Explora tablas, ejecuta consultas SQL de solo lectura y conserva las 10 versiones anteriores con opción de restaurar. |
| **Usuarios** *(admin)* | Crear cuentas con rol **Administrador**, **Editor** (sube, organiza, comparte) o **Lector** (solo ve y descarga). |
| **Códigos de acceso** *(admin)* | Genera códigos de invitación (rol, caducidad y número de usos). La persona pulsa “¿Tienes un código de acceso?” en la pantalla de inicio, o abre el enlace de invitación, y crea su propia cuenta. |
| **Dominio** *(admin)* | Estado de todas las direcciones de acceso y asistente para conectar tu propio dominio con Cloudflare (dirección fija con HTTPS). |
| **Actividad** *(admin)* | Registro de accesos, intentos fallidos, subidas, descargas y cambios. |
| **Ajustes** | Tu cuenta y contraseña, direcciones de conexión, uso del espacio por tipo de archivo, nombre del estudio, duración de la sesión. |

Atajos: `/` buscar · `Supr` papelera · `F2` renombrar · `Ctrl+A` seleccionar todo · `Esc` cancelar · `←` `→` en la vista previa.

## Archivos del proyecto

| Archivo | Para qué sirve |
|---|---|
| `INICIAR.bat` | Arranca el servidor y el enlace por internet |
| `INICIAR (solo red local).bat` | Solo para equipos conectados al mismo WiFi/router |
| `RESTABLECER CONTRASENA.bat` | Si olvidas una contraseña: la cambia desde este equipo |
| `ACTIVAR INICIO AUTOMATICO.bat` | El hosting arranca solo cada vez que inicias sesión en Windows (activado) |
| `QUITAR INICIO AUTOMATICO.bat` | Desactiva el arranque automático |
| `storage/` | Aquí se guardan tus archivos |
| `databases/` | Bases de datos subidas y su historial de versiones |
| `data/` | Usuarios, enlaces, códigos, papelera y actividad |
| `lib/` | Módulos del servidor (código, bases de datos, dominio) |
| `config.json` | Ajustes técnicos |

## Seguridad

- Contraseñas guardadas cifradas (scrypt), nunca en texto plano.
- Bloqueo de 15 minutos tras 8 intentos fallidos.
- La primera cuenta desde fuera exige el código que solo se ve en este equipo.
- Sesiones con cookie protegida (HttpOnly, SameSite, Secure).
- Acceso por internet siempre por HTTPS (túnel de Cloudflare).
- Ningún archivo puede leerse ni escribirse fuera de `storage/`.

## Notas

- **La dirección del túnel temporal cambia cada vez que inicias el hosting.** Para una dirección fija, conecta tu dominio en la sección **Dominio** (requiere un dominio en una cuenta gratuita de Cloudflare).
- Requiere [Node.js](https://nodejs.org) (ya instalado en este equipo).
- Windows puede preguntar si permites el acceso a la red la primera vez: acepta en **redes privadas**.
