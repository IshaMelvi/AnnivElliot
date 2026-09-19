const canvas = document.querySelector('#confetti');
const context = canvas.getContext('2d');
const colors = ['#ffd86b', '#ff80b9', '#a984ff', '#79e5dc', '#ffffff'];
let pieces = [];
let started = 0;

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function animate(time) {
  if (!started) started = time;
  context.clearRect(0, 0, innerWidth, innerHeight);
  if (time - started < 1500 && pieces.length < 260) {
    for (let i = 0; i < 8; i++) {
      pieces.push({ x: Math.random() * innerWidth, y: -20, vx: (Math.random() - .5) * 6,
        vy: 2 + Math.random() * 3, size: 4 + Math.random() * 7, angle: Math.random() * 7,
        spin: (Math.random() - .5) * .2, color: colors[Math.floor(Math.random() * colors.length)] });
    }
  }
  for (const piece of pieces) {
    piece.x += piece.vx;
    piece.y += piece.vy;
    piece.angle += piece.spin;
    context.save();
    context.translate(piece.x, piece.y);
    context.rotate(piece.angle);
    context.fillStyle = piece.color;
    context.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * .65);
    context.restore();
  }
  pieces = pieces.filter((piece) => piece.y < innerHeight + 30);
  if (pieces.length || time - started < 1500) requestAnimationFrame(animate);
}

window.addEventListener('resize', resize);
resize();
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(animate);
