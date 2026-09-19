# AnnivElliot

Un cadeau d'anniversaire composé d'une page GitHub Pages, d'un serveur de signalisation Socket.IO et d'une application Electron pour deux personnes.

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
│  └─ app.js
├─ signaling/             # serveur Render
│  ├─ package.json
│  └─ server.js
└─ desktop/               # application Windows Electron
   ├─ package.json
   ├─ main.js
   ├─ preload.js
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

Dans GitHub, active **Settings → Pages → Deploy from a branch → main → /docs**. Le bouton télécharge `AnnivElliot-Setup.exe` depuis la dernière GitHub Release du dépôt `IshaMelvi/AnnivElliot`.

## 3. Application Electron

L'URL du serveur Render déjà utilisé est définie dans [desktop/renderer/app.js](desktop/renderer/app.js). Pour un essai avec un serveur local, remplace-la provisoirement par `http://localhost:3000`.

```powershell
cd desktop
npm.cmd install
npm.cmd start
```

Pour vérifier la connexion et les changements de flux sans utiliser de vrais périphériques, le test d'intégration lance deux fenêtres Electron masquées et un serveur local avec des médias synthétiques :

```powershell
npm.cmd run test:integration
```

Sur Windows, pour produire l'installateur :

```powershell
npm.cmd run build:win
```

Le fichier `desktop/dist/AnnivElliot-Setup.exe` est à téléverser dans une GitHub Release publiée. Le lien du site fonctionnera alors. Pour tester avec deux personnes, lancez chacun l'application et choisissez le même nom de salon. Seul le micro est demandé à l'entrée ; la webcam et l'écran s'activent ensuite par leurs boutons. Un nom long et difficile à deviner sert de secret partagé.

## Fonctionnement et limites

- Chaque personne envoie son micro dès l'entrée du salon. La webcam démarre désactivée et sa capture est arrêtée quand on la coupe. L'écran est partagé seulement après un choix explicite. Les deux personnes peuvent ensuite émettre et regarder.
- Les commandes du salon apparaissent au mouvement de la souris puis s'effacent après quelques secondes. Le bouton écran ouvre les onglets **Fenêtres** et **Écrans entiers**, suivis des choix 720p/1080p et 30/60 fps. Le bouton plein écran affiche l'application sans les bordures de la fenêtre.
- Les plafonds vidéo du partage sont de 4 Mbit/s (720p30), 6 Mbit/s (720p60), 8 Mbit/s (1080p30) et 12 Mbit/s (1080p60). Ce sont des limites et des préférences, pas des débits ou résolutions garantis. À 60 fps, l'encodage demande davantage de calcul et généralement plus de débit ; à débit fixe, chaque image reçoit moins de données et peut paraître moins nette.
- L'audio système via `loopback` est officiellement pris en charge par l'API Electron utilisée ici sur Windows. Cette version cible Windows et ne construit qu'un installateur Windows ; macOS/Linux demanderaient des adaptations, notamment pour l'audio système et les permissions de capture.
- STUN seul ne permet pas de franchir tous les NAT et pare-feu. Si les deux personnes ne se connectent pas en WebRTC, il faut ajouter un serveur TURN. Dans ce cas, les médias passeraient par ce relais ; le serveur de signalisation reste un simple pont.
- Le flux est chiffré par WebRTC. Le nom du salon est envoyé au serveur sous forme de SHA-256, mais il ne s'agit pas d'une authentification forte : utilisez un secret long et partagez-le en privé.
- Utilisez un casque pour éviter que l'audio de l'autre personne, rejoué localement, soit repris dans l'audio système partagé.
- L'installateur de cet exemple n'est pas signé : Windows peut afficher un avertissement SmartScreen. Pour le distribuer plus largement, signe l'application avec un certificat adapté.
