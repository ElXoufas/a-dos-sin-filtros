# A DOS · SIN FILTROS V6 — actualizar SIN perder tus cartas

## ¿Tengo que pasar mi cards.js?

**Sí, si lo has modificado tú en el ordenador.** Está en la carpeta principal del proyecto (junto a `server.js`).

- La actualización **PARCHE-V6-SIN-CARDS.zip** NO contiene `cards.js`: se aplica encima de tu carpeta actual y **no borra ni sustituye tus preguntas/retos**.
- La versión **A-DOS-SIN-FILTROS-V6-COMPLETO.zip** trae `cards.js` de la V5 como ejemplo. Si has modificado el tuyo, **no lo sobrescribas**: copia el TUYO sobre el del ZIP completo antes de publicarlo.
- Si escribiste las cartas **dentro del juego, en «Vuestras propias cartas»**, esas cartas solo viven en la sala actual y NO se exportan a `cards.js` automáticamente. Si quieres conservarlas entre reinicios, escríbelas en tu `cards.js` o guarda el texto por separado. Esta versión mantiene el comportamiento anterior.

## Archivos del parche

Copia dentro de la carpeta principal del juego:

- `server.js` — nuevos endpoints de chat y envío en fragmentos
- `transfer-layer.js` — **nuevo, obligatorio**; servidor temporal para archivos cifrados
- `public/app.js` — chat, grabadora y subida/descarga cifrada
- `public/index.html` — interfaz nueva
- `public/style.css` — estilos de chat y visor
- `package.json` — versión 6
- `tests/chat-large-media.test.js` — pruebas nuevas
- `LEEME_ACTUALIZACION_V6.md` — esta guía

No cambies `cards.js`. Mantén el resto de archivos del proyecto original.

## Para probarlo en Windows

1. Entra en la carpeta principal y abre `INICIAR_WINDOWS.bat` (Node.js 20+).
2. Abre en el navegador `http://localhost:3000`.
3. El otro móvil debe usar un enlace accesible por red o el sitio web publicado. En localhost de un móvil distinto no funcionará.
4. Comparte el **enlace completo** de invitación, incluido el trozo `#k=...`, para que los dos podáis leer/enviar chat y archivos cifrados.
5. Probáis texto, un audio, una foto y después un vídeo corto antes de usar vídeos grandes.

Para comprobar con Node: `npm test`.

## Para actualizar GitHub / Render

Si tienes GitHub conectado a Render, sube la actualización a **la raíz del mismo repositorio** y asegúrate de que también esté el nuevo `transfer-layer.js`.

**No sustituyas tu `cards.js`**; mantén tus cartas actuales. Una vez subida la actualización a la rama utilizada por Render, inicia o comprueba el nuevo despliegue. La URL sigue siendo la misma si usas el mismo servicio.

En Render la modalidad gratuita puede dormir la aplicación y perder las salas activas; los mensajes y archivos son temporales. Los archivos **no se guardan en un disco persistente**: solo se guardan **cifrados y por unos 15 minutos en memoria RAM**. Si Render reinicia, desaparecen incluso antes. No es un servicio de almacenamiento de recuerdos.

## Límites y privacidad

- Vídeos: máximo **5 minutos y 150 MiB** (unos 157 MB decimales). Se comprueba la duración en el navegador. Si es más pesado hay que recortarlo o comprimirlo, preferiblemente a 720p / MP4.
- Fotos: 15 MiB. Audios de chat: 2 minutos / 15 MiB.
- Envío por fragmentos cifrados de 1 MiB, con barra porcentual y reintentos en cortes puntuales de red. La rapidez depende de la conexión móvil. No puede garantizarse que funcionen todos los vídeos en todos los móviles (p. ej., HEVC/MOV puede no reproducirse en Android).
- Las claves AES-GCM se generan en el dispositivo y se comparten con el fragmento privado del enlace. El servidor recibe ciphertext, no contenido de las fotos, audios, vídeos ni mensajes de chat.
- Los archivos se retienen cifrados temporalmente **hasta 15 minutos**, para que el destinatario pueda recuperarlos. Si alguien retira el consentimiento de cámara, los archivos de los retos se invalidan.
- Los mensajes cifrados de chat se conservan solo mientras exista la sala (memoria del proceso), no para siempre. Máximo 65 mensajes visibles.
- Es posible que alguien que reciba un archivo lo copie o capture. Comparte solo lo que quieras y con personas adultas de confianza.
- HTTPS es imprescindible para cifrado y micrófono en teléfonos; funciona en localhost para pruebas locales.
- La implementación está pensada para salas pequeñas (dos jugadores) y almacenamiento efímero; para alojar muchas partidas y vídeos simultáneos se necesitaría un servicio de almacenamiento adecuado y políticas explícitas de privacidad.

Si tienes tus cartas guardadas en un archivo propio, no es necesario que me lo envíes para instalar esta actualización: **basta con conservarlo**.
