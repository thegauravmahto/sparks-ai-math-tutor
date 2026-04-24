// Avatar animation: mouth scales with audio amplitude, blinking, eye tracking mouse.
(() => {
  const svg = document.getElementById("avatar");
  const mouth = document.getElementById("mouth");
  const tongue = document.getElementById("tongue");
  const eyes = document.querySelectorAll("#eyes .pupil");
  const glints = document.querySelectorAll("#eyes .glint");
  const eyeWhites = document.querySelectorAll("#eyes .eye-white");

  // --- Mouth animation driven by audio RMS ---
  let targetAmp = 0;
  let currentAmp = 0;

  window.setMouthAmplitude = function (amp) {
    // amp: 0..1
    targetAmp = Math.min(1, Math.max(0, amp));
  };

  function animateMouth() {
    // Smooth easing toward target
    currentAmp += (targetAmp - currentAmp) * 0.35;
    const ry = 6 + currentAmp * 22;    // base 6 → up to 28
    const rx = 22 - currentAmp * 4;    // slightly narrower when open
    mouth.setAttribute("ry", ry.toFixed(2));
    mouth.setAttribute("rx", rx.toFixed(2));
    // Tongue follows
    const ty = 2 + currentAmp * 8;
    tongue.setAttribute("d", `M-10 ${ty - 2} Q0 ${ty + 6} 10 ${ty - 2}`);
    tongue.setAttribute("opacity", 0.6 + currentAmp * 0.4);
    requestAnimationFrame(animateMouth);
  }
  animateMouth();

  // --- Blinking ---
  function blink() {
    eyeWhites.forEach((e) => e.setAttribute("ry", "1.5"));
    setTimeout(() => {
      eyeWhites.forEach((e) => e.setAttribute("ry", "16"));
    }, 140);
    const next = 2500 + Math.random() * 3500;
    setTimeout(blink, next);
  }
  setTimeout(blink, 2000);

  // --- Eye tracking (subtle) ---
  window.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / window.innerWidth;   // -0.5..0.5
    const dy = (e.clientY - cy) / window.innerHeight;
    const mx = Math.max(-1, Math.min(1, dx * 2));
    const my = Math.max(-1, Math.min(1, dy * 2));
    const offs = [
      { base: [74, 104] },
      { base: [130, 104] },
    ];
    eyes.forEach((p, i) => {
      const [bx, by] = offs[i].base;
      p.setAttribute("cx", bx + mx * 4);
      p.setAttribute("cy", by + my * 3);
    });
    glints.forEach((g, i) => {
      const [bx, by] = offs[i].base;
      g.setAttribute("cx", bx - 1 + mx * 4);
      g.setAttribute("cy", by - 3 + my * 3);
    });
  });

  // --- Talking class toggle (faster bob when speaking) ---
  window.setAvatarTalking = function (on) {
    svg.classList.toggle("talking", !!on);
  };
})();
