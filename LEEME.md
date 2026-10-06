# Noir Studio · Hosting privado

Servidor de archivos privado con usuarios, contraseñas, Código y Bases de datos. **Todo está en la nube**: no hace falta
tener ningún PC encendido.

## Cómo entrar

Abre **https://noirstudio-web.github.io/hosting/** desde cualquier equipo o celular y entra con tu usuario y contraseña.

- **La web** se carga desde GitHub Pages (este repositorio, carpeta `docs/`).
- **El servidor, los archivos y las cuentas** están en la nube de **Neon** (región aws-us-east-1):
  - Archivos, proyectos de Código y bases de datos → *Neon Object Storage* (bucket `noir`).
  - Usuarios, enlaces, papelera, ajustes y actividad → *Postgres* de Neon.
  - Servidor → *Neon Functions* (`cloud/function.mjs` arranca `server.js` en modo nube).
- Las subidas van **directamente del navegador a la nube**, por partes de 16 MB que se reanudan si se corta la conexión.

> El plan gratuito de Neon incluye 5 GB de archivos y 5 GB de descargas al mes. Si se queda corto, sube a un plan de pago
> en la consola de Neon (proyecto **noir-studio**).

## Publicar una actualización (desde este PC)

Doble clic en **`PUBLICAR ACTUALIZACION.bat`**: despliega el servidor en la nube (`neon deploy`) y publica la web en
GitHub. Requiere este PC vinculado al proyecto de Neon (`.neon` y `.env.local`, que nunca se suben a GitHub).

Para pasar datos de un servidor local a la nube: `node scripts/nube-importar.cjs`.

## Qué incluye

| Sección | Qué puedes hacer |
|---|---|
| **Archivos** | Botón **Subir** → *Subir archivos* o *Subir carpeta* (o arrastrar), crear carpetas, renombrar, mover, copiar, descargar (carpetas como ZIP), vista previa de imágenes, video, audio, PDF y texto. Clic derecho para el menú de opciones. Arrastra archivos sobre una carpeta para moverlos. |
| **Búsqueda** | Escribe en el buscador para filtrar la carpeta; pulsa **Enter** para buscar en todas las carpetas. |
| **Compartidos** | Enlaces públicos de descarga para quien no tiene cuenta, con caducidad, contraseña y límite de descargas opcionales. |
| **Papelera** | Lo eliminado va aquí y se puede restaurar. Se vacía sola tras los días configurados. |
| **Código** | Explorador de los proyectos que estás desarrollando: árbol de carpetas, resaltado de sintaxis, búsqueda por nombre o contenido, últimos commits de Git y descarga en ZIP. Solo lectura; `.env`, claves y `node_modules` se ocultan siempre. Para subir un proyecto, arrastra su carpeta (sin `node_modules` ni claves). |
| **Bases de datos** | Sube bases SQLite (.db, .sqlite), volcados .sql, CSV o JSON. Explora tablas, ejecuta consultas SQL de solo lectura y conserva las 10 versiones anteriores con opción de restaurar. |
| **Usuarios** *(admin)* | Crear cuentas con rol **Administrador**, **Editor** (sube, organiza, comparte) o **Lector** (solo ve y descarga). |
| **Códigos de acceso** *(admin)* | Genera códigos de invitación (rol, caducidad y número de usos). La persona pulsa “¿Tienes un código de acceso?” en la pantalla de inicio, o abre el enlace de invitación, y crea su propia cuenta. |
| **Actividad** *(admin)* | Registro de accesos, intentos fallidos, subidas, descargas y cambios. |
| **Ajustes** | Tu cuenta y contraseña, direcciones de conexión, uso del espacio por tipo de archivo, nombre del estudio, duración de la sesión. |

Atajos: `/` buscar · `Supr` papelera · `F2` renombrar · `Ctrl+A` seleccionar todo · `Esc` cancelar · `←` `→` en la vista previa.

## Archivos del proyecto

| Archivo | Para qué sirve |
|---|---|
| `PUBLICAR ACTUALIZACION.bat` | Publica una nueva versión (servidor en la nube + web) |
| `server.js` | Servidor (el mismo en la nube y en un PC) |
| `cloud/function.mjs` | Arranque del servidor en Neon Functions |
| `neon.ts` | Infraestructura en la nube: bucket de archivos y función del servidor |
| `lib/` | Módulos del servidor (nube, almacenamiento, código y bases de datos) |
| `public/` → `docs/` | La web (`docs/` es la copia que publica GitHub Pages) |
| `scripts/nube-importar.cjs` | Pasa usuarios, proyectos y archivos de un servidor local a la nube |
| `INICIAR.bat` y demás `.bat` | Modo antiguo: servidor en un PC (ya no hace falta) |

## Seguridad

- Contraseñas guardadas cifradas (scrypt), nunca en texto plano.
- Bloqueo de 15 minutos tras 8 intentos fallidos.
- La primera cuenta desde fuera exige el código que solo se ve en este equipo.
- Sesiones guardadas en la nube; cerrar sesión o cambiar la contraseña las invalida al momento.
- Todo el tráfico va por HTTPS. Los archivos están en un bucket privado: solo se leen con enlaces firmados que caducan.
- Los archivos de texto se entregan siempre como texto plano (nunca se ejecutan en el navegador).

## Notas

- La primera visita tras un rato sin uso tarda unos segundos: el servidor en la nube «despierta».
- La sección **Almacenamiento** muestra el espacio usado del plan de la nube.
