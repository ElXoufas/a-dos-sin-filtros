# A DOS · Sin filtros

Juego web para dos personas adultas. Verdades y retos para parejas, con código de sala, dos dispositivos sincronizados en tiempo real, niveles de intensidad y cartas personalizadas. Diseñado para móviles y también utilizable desde un ordenador.

## ¿Qué incluye?

- **204 cartas originales** (verdades, retos y propuestas opcionales de cámara), repartidas en 3 niveles: Chispa, Fuego e Intenso.
- Salas con código aleatorio de seis caracteres y enlace compartible.
- En cada turno, elección de **Verdad**, **Reto** o **Suerte**.
- Puntuación, historial, temporizador compartido de 60 segundos y opción de pasar cualquier carta.
- Retos opcionales de foto/vídeo, **solo disponibles cuando ambos los aceptan**. El permiso se puede retirar en cualquier momento.
- Hasta 50 cartas **personalizadas** por sala (verdad, reto, foto o vídeo).
- **Fotos y vídeos opcionales** de hasta 12 MB: el navegador los cifra con AES-GCM antes de enviarlos; el servidor retransmite los datos cifrados a la otra persona por la conexión en tiempo real, sin guardar el archivo ni la clave. Quien lo recibe puede verlo, pero podría hacer una captura o copia. Para usar esta función hace falta abrir la web con HTTPS y compartir el enlace de invitación completo, incluida su clave tras `#k=`.
- Sin anuncios, sin cuentas y sin paquetes npm externos.
- Manifest de aplicación web instalable desde navegador móvil.

## Opción A: probarlo en Windows

1. Instala **Node.js LTS** desde https://nodejs.org/ (solo la primera vez).
2. Extrae por completo el archivo ZIP.
3. Abre `INICIAR_WINDOWS.bat` dentro de la carpeta.
4. En tu navegador entra en **http://localhost:3000**. Debes mantener la ventana negra abierta mientras se juega.
5. Para que la segunda persona se conecte desde **otro dispositivo de la misma WiFi**, consulta la dirección IPv4 del PC ejecutando `ipconfig` en la terminal de Windows. Por ejemplo, si fuera `192.168.1.43`, entraría en `http://192.168.1.43:3000`. El firewall de Windows puede pedirte permiso para Node.js en redes privadas. El móvil y el ordenador deben estar en la misma WiFi. **Aviso:** el envío cifrado de fotos y vídeos requiere HTTPS o localhost, por lo que no funcionará desde otro móvil mediante una URL HTTP de la red local; utiliza la opción B para esa función.
6. Una persona pulsa **Crear sala** y la otra **Unirme**, introduciendo el código. Los dos pulsan **Estoy listo/a**; el anfitrión pulsa **Empezar partida**.

> `localhost` solo funciona en el dispositivo donde se ejecuta el servidor. Para jugar desde dos casas distintas o por datos móviles, hay que publicarlo en internet (opción B).

## Opción B: tener una web pública y jugar a distancia

Una forma sencilla para una web privada de ocio es desplegar esta misma carpeta en **Render**. Los planes gratuitos y las condiciones pueden cambiar.

1. Crea una cuenta en GitHub: https://github.com/.
2. Crea un repositorio nuevo (puede ser **privado**). En el navegador de GitHub, usa **Add file → Upload files** y arrastra **el contenido** de la carpeta descomprimida, incluido `server.js`, `package.json`, `public/` y `render.yaml`. Confirma con **Commit changes**. No subas el archivo ZIP como único contenido ni dejes todos los archivos dentro de otra subcarpeta.
3. En https://dashboard.render.com/ inicia sesión y selecciona **New → Web Service**. Conecta GitHub y selecciona el repositorio.
4. Escoge **Node**, rama `main`, **Root Directory** vacío, plan **Free** si está disponible, comando de construcción `npm install` y comando de inicio `npm start`. Deja una sola instancia y pulsa **Deploy Web Service**.
5. Cuando el servicio esté en estado **Live**, Render te asignará una URL que termina en `onrender.com`. Ambos abrís **esa misma URL**, desde cualquier lugar. El creador usa **Compartir enlace** para invitar al segundo jugador; no compartáis públicamente el enlace completo porque incluye una clave privada para archivos cifrados.
6. Cread la sala, compartid el enlace y empezad. En iPhone puedes usar **Compartir → Añadir a pantalla de inicio** para abrirlo como si fuera una app.

**Límites**: las salas se guardan en memoria y desaparecerán si se reinicia el proceso. Render puede suspender servicios gratuitos después de un tiempo de inactividad y tardar en reactivarlos. La sala es privada por código y token por participante, no hay contraseñas de cuentas. Si se busca un despliegue duradero, hace falta una base de datos y un alojamiento estable.

## Para quien quiera iniciarlo en macOS/Linux

Con Node.js 20 o superior:

```bash
node server.js
```

Acceder en `http://localhost:3000`. O, con npm, `npm start`.

## Comprobar que funciona

```bash
npm test
```

Las pruebas verifican: creación y unión de sala, límite de dos participantes, reglas, permisos, cambios de turno, bloqueo de acciones del otro jugador, sincronización mediante eventos del servidor, puntuación, reinicio y salida.

## Privacidad y consentimiento

- Juego exclusivamente para mayores de edad que participen de forma voluntaria.
- Nada obliga a hacer, mostrar, fotografiar o enviar contenido íntimo. **Pasar** nunca supone penalización.
- El envío opcional de archivos cifra su contenido en el dispositivo antes de transmitirlo mediante el servidor; el servidor puede ver datos técnicos como tamaño y formato, pero no el contenido descifrado. No se guarda en disco ni se conserva historial de archivos. El receptor aún puede guardar o capturar contenido que vea.
- No compartáis contenido privado si existe presión o si no tenéis plena confianza en cómo se tratará fuera del juego.
- No hay base de datos ni analíticas, pero en un despliegue público el proveedor de hosting puede tener registros técnicos de conexión.

## Licencia y estructura

Proyecto privado de ejemplo. `server.js` es el servidor HTTP y el motor del juego; `cards.js` contiene las cartas; `public/` la interfaz. No requiere instalar dependencias JavaScript externas.

Despliegue de referencia: [Documentación oficial de Render](https://render.com/docs/your-first-deploy) y [limitaciones del plan gratuito](https://render.com/docs/free).
