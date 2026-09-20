# CherubLink

Un cadeau d'anniversaire composé d'une page GitHub Pages, d'un serveur de signalisation Socket.IO et de CherubLink, une application Electron pour deux personnes.

## Prérequis Windows

Installe la version **LTS de Node.js** depuis <https://nodejs.org/en/download> avec l'installateur Windows. L'installation inclut npm. Ferme puis rouvre PowerShell ou le terminal intégré de VS Code, et vérifie :

```powershell
node --version
npm.cmd --version
```

Si `node` reste introuvable mais que `C:\Program Files\nodejs\node.exe` existe, l'installation est présente et le terminal n'a pas encore récupéré son nouveau `PATH` : ferme complètement VS Code puis rouvre-le. Utilise `npm.cmd` dans PowerShell ; cela évite les erreurs possibles liées à la politique d'exécution de `npm.ps1`.

## Arborescence

```text
AnnivElliot/
├─ render.yaml            # déploiement Render (Blueprint)
├─ docs/                  # site GitHub Pages
│  ├─ index.html
│  ├─ style.css
│  ├─ assets/             # logo CherubLink et portrait d'anniversaire
│  └─ app.js
├─ signaling/             # serveur Render
│  ├─ package.json
│  └─ server.js
└─ desktop/               # application Windows Electron
   ├─ package.json
   ├─ main.js
   ├─ preload.js
   ├─ assets/            # logo utilisé par l'interface et l'icône Windows
   └─ renderer/
      ├─ index.html
      ├─ style.css
      └─ app.js
```

## 1. Serveur de signalisation

Après installation de Node.js (version 20 ou plus) :

```powershell
cd signaling
npm.cmd install
npm.cmd start
```

Le serveur écoute sur `PORT` (3000 par défaut). Vérification : `http://localhost:3000/health`.

Sur Render, crée un *Blueprint* depuis le `render.yaml` à la racine du dépôt. Tu peux aussi créer un *Web Service* manuellement, avec `signaling` comme **Root Directory**, `npm install` comme **Build Command** et `npm start` comme **Start Command**. Un seul processus suffit. L'offre gratuite peut se mettre en veille : la première connexion peut prendre du temps. Le serveur n'enregistre rien ; les salons n'existent qu'en mémoire pendant les connexions.

## 2. Site anniversaire

Dans GitHub, active **Settings → Pages → Deploy from a branch → main → /docs**. Le bouton télécharge `CherubLink-Setup.exe` depuis la dernière GitHub Release du dépôt `IshaMelvi/AnnivElliot`.

Le portrait et le logo fournis sont conservés dans `docs/assets/`. Le portrait apparaît au centre de la page, entouré d'étoiles animées en CSS. L'animation s'arrête si le visiteur demande une réduction des mouvements. Le logo de l'application est également présent dans `desktop/assets/` pour fonctionner hors ligne et générer l'icône Windows.

## 3. Application Electron

L'URL du serveur Render déjà utilisé est définie dans [desktop/renderer/app.js](desktop/renderer/app.js). Pour un essai avec un serveur local, remplace-la provisoirement par `http://localhost:3000`.

```powershell
cd desktop
npm.cmd install
npm.cmd start
```

Pour vérifier la connexion et les changements de flux sans utiliser de vrais périphériques, le test d'intégration lance deux fenêtres Electron masquées et un serveur local avec des médias synthétiques :

```powershell
npm.cmd test
npm.cmd run test:integration
```

Sur Windows, pour produire l'installateur :

```powershell
npm.cmd run build:win
```

Le fichier `desktop/dist/CherubLink-Setup.exe` est à téléverser dans une GitHub Release publiée. Le lien du site fonctionnera alors. Pour tester avec deux personnes, lancez chacun l'application et choisissez le même nom de salon. Seul le micro est demandé à l'entrée ; la webcam et l'écran s'activent ensuite par leurs boutons. Un nom long et difficile à deviner sert de secret partagé.

Le nom affiché devient CherubLink. L'identifiant d'installation `ch.annivelliot.stream`, le dossier de profil `%APPDATA%/annivelliot-desktop` et la clé des préférences existante sont conservés pour retrouver les profils et les volumes enregistrés. Le dépôt GitHub et l'adresse du serveur Render gardent leurs noms actuels.

## Fonctionnement et limites

- Chaque personne envoie son micro dès l'entrée du salon. La webcam démarre désactivée et sa capture est arrêtée quand on la coupe. L'écran est partagé seulement après un choix explicite. Les deux personnes peuvent ensuite émettre et regarder.
- Les commandes du salon apparaissent au mouvement de la souris puis s'effacent après trois secondes. Le bouton écran ouvre les onglets **Fenêtres** et **Écrans entiers**, suivis des choix 720p/1080p et 30/60 fps. Le bouton plein écran affiche uniquement la zone vidéo : la colonne des participants disparaît, tandis que les PiP et les commandes flottantes restent disponibles. La vidéo principale est affichée entièrement, sans recadrage. Échap, le bouton de plein écran ou la sortie du salon permettent de revenir à la vue normale.
- Cliquez sur la grande vidéo ou sur sa zone vide pour afficher côte à côte celle de votre ami et la vôtre. Cliquez ensuite sur une moitié pour l'agrandir ; vous pouvez refaire ce cycle autant de fois que vous voulez, même sans vidéo locale. Votre moitié montre l'écran partagé s'il est actif, sinon la webcam. Quand votre écran et votre webcam sont actifs, votre webcam apparaît aussi en PiP dans la vue de votre partage personnel, à côté du PiP de votre ami. Les PiP se déplacent à la souris et se redimensionnent par leur coin inférieur droit, jusqu'à un quart de la fenêtre. Les vues sans vidéo montrent le logo avec une couleur propre à chaque participant. Quand l'autre personne coupe son micro, une indication discrète apparaît sur sa vidéo.
- La bande de gauche montre les deux personnes du salon. Chacun peut renseigner un prénom facultatif avant d'entrer. Un clic droit sur l'autre personne ouvre son volume entrant et un bouton pour la rendre muette. Le curseur à gauche du bouton plein écran règle seulement l'audio du partage vidéo reçu ; le réglage de la personne agit sur son micro et sur cet audio.
- **Paramètres**, en bas de la colonne (également accessible avant de rejoindre), permet de choisir l'entrée et la sortie audio et le volume général. Les préférences sont conservées localement. Le volume entendu est le produit du volume général, du volume de la personne et, pour le son du partage uniquement, du curseur vidéo. Changer le volume général n'écrase aucun réglage individuel. Un périphérique enregistré devenu introuvable au lancement est remplacé par celui de Windows par défaut avec un message ; un changement manuel qui échoue conserve le périphérique précédent.
- Le micro dispose d'une détection de voix automatique ou d'un seuil manuel (-65 à -10 dBFS), avec une jauge et un test avant l'entrée. Plus le seuil est bas, plus une voix faible passe. Le traitement s'exécute dans un AudioWorklet : anticipation de 20 ms, maintien de 250 ms après la voix et transitions progressives. Il ne s'applique jamais à l'audio du film. Le bouton muet reste prioritaire sur la détection. Le test local ne diffuse pas la voix et s'arrête à la fermeture des paramètres ; en salon, fermer les paramètres laisse le micro fonctionner. Un changement de micro conserve la piste WebRTC et son état muet.
- Le prénom, la résolution et la fréquence de partage, ainsi que les volumes et l'état muet associés à chaque ami, sont conservés localement entre les lancements. Un identifiant aléatoire de profil sert à retrouver les réglages du même ami ; le serveur ne les stocke pas. Si les données locales de l'application sont effacées, un nouvel identifiant est créé et l'association avec les anciens réglages est perdue.
- Quand la vue de votre ami est au premier plan, l'application met en pause et détache vos aperçus locaux masqués. Votre écran et votre webcam restent capturés et encodés tant que leurs boutons de partage sont actifs : ces flux doivent continuer à parvenir à votre ami. Pour réduire davantage la charge, arrêtez le partage ou la webcam dont vous n'avez plus besoin, ou choisissez 30 fps dans le sélecteur.
- Un salon est limité à deux personnes parce que l'application et sa signalisation gèrent une seule connexion WebRTC distante. Agrandir le salon demanderait aussi de gérer plusieurs flux et connexions : en pair à pair, chaque personne devrait envoyer sa vidéo à chaque autre personne, ce qui augmente vite la charge de sa connexion montante.
- Les plafonds vidéo du partage sont de 4 Mbit/s (720p30), 6 Mbit/s (720p60), 8 Mbit/s (1080p30) et 12 Mbit/s (1080p60). Ce sont des limites et des préférences, pas des débits ou résolutions garantis. À 60 fps, l'encodage demande davantage de calcul et généralement plus de débit ; à débit fixe, chaque image reçoit moins de données et peut paraître moins nette.
- La capture applique désormais les dimensions et la fréquence choisies comme des plafonds : un écran 4K n'est pas capturé volontairement en 4K pour un partage 1080p. WebRTC privilégie la fréquence d'images (`maintain-framerate`) et peut réduire la résolution si le processeur ou le réseau l'exige. La webcam est plafonnée à 1,2 Mbit/s et reçoit une priorité inférieure au partage. Les paramètres sont réappliqués après négociation. L'application continue le traitement en arrière-plan lorsque le lecteur vidéo est au premier plan.
- **Paramètres → Qualité du partage** affiche les mesures réelles d'envoi/réception pendant que le menu est ouvert : résolution, fps, débit, temps d'encodage, pertes et tampon de réception. Le diagnostic copiable ajoute notamment la latence aller-retour et l'implémentation du codec si Chromium les expose, sans adresse IP, nom de salon ou nom de périphérique. Attendre plusieurs secondes puis copier le diagnostic sur les deux ordinateurs pendant les saccades. Les médias synthétiques des tests ne constituent pas une mesure de fluidité 1080p sur Internet.
- L'audio système via `loopback` est officiellement pris en charge par l'API Electron utilisée ici sur Windows. Cette version cible Windows et ne construit qu'un installateur Windows ; macOS/Linux demanderaient des adaptations, notamment pour l'audio système et les permissions de capture.
- STUN seul ne permet pas de franchir tous les NAT et pare-feu. Si les deux personnes ne se connectent pas en WebRTC, il faut ajouter un serveur TURN. Dans ce cas, les médias passeraient par ce relais ; le serveur de signalisation reste un simple pont.
- Le flux est chiffré par WebRTC. Le nom du salon est envoyé au serveur sous forme de SHA-256, mais il ne s'agit pas d'une authentification forte : utilisez un secret long et partagez-le en privé.
- Un casque évite le retour acoustique dans le micro. La capture demande aussi `restrictOwnAudio` (pris en charge dans la version Electron utilisée) pour exclure le son rejoué par CherubLink du loopback sur les systèmes compatibles. Le casque seul n'exclut pas ce son d'une capture système. Les autres applications peuvent être audibles dans le partage : fermez leurs sons et notifications si nécessaire.
- L'installateur de cet exemple n'est pas signé : Windows peut afficher un avertissement SmartScreen. Pour le distribuer plus largement, signe l'application avec un certificat adapté.

## Tester un film et dépanner le son sous Windows 11

1. Installer la même nouvelle version de CherubLink sur les deux ordinateurs. Vérifier le micro et choisir le casque dans **Paramètres**.
2. Lancer le film, puis partager sa fenêtre en **1080p / 30 fps**, avec **Partager le son de l'ordinateur** coché. La capture du film désactive la suppression de bruit, l'annulation d'écho et le gain automatique réservés à la voix.
3. Si `Could not start audio source` apparaît **au partage**, le message concerne la capture audio système et n'établit pas que Discord occupe le micro. Vérifier qu'un casque ou des haut-parleurs sont actifs dans Windows ; essayer après avoir fermé Discord et les autres applications audio, puis vérifier le mode exclusif du périphérique dans Windows. Il n'y a pas besoin de rouvrir la liste pour réessayer la même source.
4. **Réessayer sans le son du partage** sert à isoler le problème audio et conserve le micro. Cela ne rétablit pas le son du film : après correction du périphérique, arrêter le partage, recocher le son puis relancer. Une fenêtre fermée doit être remplacée avec **Actualiser les fenêtres**.
5. Si la vidéo saccade, consulter les diagnostics des deux côtés. Une limite réseau demande de vérifier aussi le débit montant de l'émetteur ; une limite processeur concerne l'encodage. Comparer Ethernet et Wi-Fi puis 1080p30 et 720p30. Le fonctionnement fluide d'autres applications sur le PC récepteur ne suffit pas à garantir la fluidité de cette liaison.

La version 1.2.0 corrige l'invalidation prématurée des sources après la première tentative de capture et respecte le choix sans audio dans le processus principal. Le serveur Render n'a pas besoin d'être modifié pour ces changements : il transporte la signalisation, les médias circulent directement entre les deux utilisateurs.
