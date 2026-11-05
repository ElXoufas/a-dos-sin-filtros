'use strict';

const cameraCardsIntenso = [
  {
    "media": "foto",
    "text": "Haz una selfie sugerente con tu look más atrevido, solo si te apetece compartirla."
  },
  {
    "media": "video",
    "text": "Graba un vídeo corto enseñando tu mejor mirada seductora a cámara."
  },
  {
    "media": "foto",
    "text": "Foto de espejo: elige una pose coqueta y un encuadre que te haga sentir bien."
  },
  {
    "media": "video",
    "text": "Haz un vídeo de diez segundos con un baile provocador, sin mostrar nada íntimo."
  },
  {
    "media": "foto",
    "text": "Si quieres, cambia de outfit y manda una foto con el nuevo look."
  },
  {
    "media": "video",
    "text": "Graba cómo te quitas una chaqueta o prenda exterior lentamente, solo si te apetece."
  },
  {
    "media": "foto",
    "text": "Haz una foto con los hombros descubiertos o un detalle de vestuario, sin enseñar zonas íntimas."
  },
  {
    "media": "video",
    "text": "Manda un vídeo privado susurrando: «Tengo una sorpresa para cuando nos veamos…»."
  },
  {
    "media": "foto",
    "text": "Fotografía tu prenda favorita para una cita a solas; puedes salir tú o solo la prenda."
  },
  {
    "media": "video",
    "text": "Graba un vídeo con una pose de pasarela usando tu outfit más atrevido."
  },
  {
    "media": "foto",
    "text": "Si os apetece a ambos, haz una foto íntima sugerente. Tú decides qué mostrar; no es obligatoria."
  },
  {
    "media": "video",
    "text": "Vídeo de quince segundos: mira a cámara, sonríe y lanza tu invitación más descarada."
  },
  {
    "media": "foto",
    "text": "Haz una foto en contraluz con una silueta sugerente, sin desnudez explícita."
  },
  {
    "media": "video",
    "text": "Graba un vídeo corto enseñando dos looks y pregunta cuál elegiría tu pareja."
  },
  {
    "media": "foto",
    "text": "Foto misteriosa: enseña solo un detalle de tu conjunto y deja el resto a la imaginación."
  },
  {
    "media": "video",
    "text": "Graba tu mejor entrada de película romántica con un giro picante."
  },
  {
    "media": "foto",
    "text": "Comparte, si quieres, una foto privada con tu pose más atrevida y cómoda."
  },
  {
    "media": "video",
    "text": "Si lo deseas, graba un vídeo cambiándote un accesorio o una capa exterior de ropa."
  },
  {
    "media": "foto",
    "text": "Haz una foto de una prenda que elegirías para sorprender a tu pareja esta noche."
  },
  {
    "media": "video",
    "text": "Manda un vídeo haciendo una pregunta atrevida que tu pareja pueda contestar o pasar."
  },
  {
    "media": "foto",
    "text": "Con luz tenue, haz una selfie sugerente que solo tenga sentido para los dos."
  },
  {
    "media": "video",
    "text": "Graba un vídeo diciendo qué plan picante pero consensuado te gustaría proponeros."
  },
  {
    "media": "foto",
    "text": "Foto de tu look «después de la cita» sin enseñar nada que quieras mantener privado."
  },
  {
    "media": "video",
    "text": "Vídeo privado de diez segundos: di tu frase más atrevida sin ser explícito/a."
  }
];

// TODO VALE: exclusivamente retos visuales +18, sin verdades ni actos sexuales explícitos.
// Participación y desnudez siempre opcionales. Cualquier reto se puede pasar.
const todoValeCards = {
  "foto": [
    {
      "media": "foto",
      "text": "Foto de espejo con el torso descubierto y la pose que tú elijas."
    },
    {
      "media": "foto",
      "text": "Foto de espalda desnuda agachada mirando por encima del hombro."
    },
    {
      "media": "foto",
      "text": "Foto de cuerpo entero en contraluz con desnudez"
    },
    {
      "media": "foto",
      "text": "Foto en la cama bajo una sábana, mostrando lo que tu quieras (hot)"
    },
    {
      "media": "foto",
      "text": "Foto frente al espejo después de quitarte una prenda, con encuadre privado."
    },
    {
      "media": "foto",
      "text": "Foto en el espejo con una bata abierta enseñando todo"
    },
    {
      "media": "foto",
      "text": "Foto con un juego de sombras que sugiera una silueta desnuda."
    },
    {
      "media": "foto",
      "text": "Foto de cuerpo entero desde un ángulo nuevo que nunca hayas usado."
    },
    {
      "media": "foto",
      "text": "Foto sentado/a en una silla con la ropa que tú elijas dejar puesta."
    },
    {
      "media": "foto",
      "text": "Foto de tus partes intimas "
    },
    {
      "media": "foto",
      "text": "Foto con una camisa larga y las piernas abiertas ante el espejo."
    },
    {
      "media": "foto",
      "text": "Foto de las tetas"
    },
    {
      "media": "foto",
      "text": "Foto polla"
    },
    {
      "media": "foto",
      "text": "Foto coño"
    }
  ],
  "video": [
    {
      "media": "video",
      "text": "Vídeo de 10 segundos tocandote las tetas"
    },
    {
      "media": "video",
      "text": "Vídeo de un giro lento mostrando la espalda desnuda, y agachandote"
    },
    {
      "media": "video",
      "text": "Vídeo de 15 segundos a 4 patas en la cama enseñando las partes"
    },
    {
      "media": "video",
      "text": "Vídeo tocandote 15 sec"
    },
    {
      "media": "video",
      "text": "Vídeo caminando hacia la cámara desnuda"
    },
    {
      "media": "video",
      "text": "Vídeo pasando de un look vestido a desnudez"
    },
    {
      "media": "video",
      "text": "Vídeo con la espalda descubierta dandose media vuelta"
    },
    {
      "media": "video",
      "text": "Vídeo posando ante el espejo con el torso descubierto y enseñando tetas"
    },
    {
      "media": "video",
      "text": "Vídeo quitándote lentamente una camisa, mostrando"
    },
    {
      "media": "video",
      "text": "Vídeo haciendo tres poses de cuerpo entero, mostrado las partes"
    },
    {
      "media": "video",
      "text": "Vídeo en color del coño"
    },
    {
      "media": "video",
      "text": "Vídeo de 10 segundos tocandote (distintas poses cada vez)"
    },
    {
      "media": "video",
      "text": "Vídeo masturbandote durante 30 segundos o mas"
    },
    {
      "media": "video",
      "text": "Vídeo mirando a la camara y tocandose las tetas"
    },
    {
      "media": "video",
      "text": "Vídeo de dos looks: uno de calle y otro desnudo"
    },
    {
      "media": "video",
      "text": "Vídeo sentado/a en una silla enseñando polla/coño (que se vea bien)"
    }
  ]
};

module.exports = { cameraCardsIntenso, todoValeCards };
