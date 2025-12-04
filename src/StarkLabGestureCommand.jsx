import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const StarkLabGestureCommand = () => {
  const canvasContainerRef = useRef(null);
  const videoRef = useRef(null);
  
  // UI Refs for high-performance updates (bypassing React state)
  const statusPhaseRef = useRef(null);
  const statusModeRef = useRef(null);
  const lStatRef = useRef(null);
  const rStatRef = useRef(null);
  const cmdStatRef = useRef(null);

  useEffect(() => {
    const container = canvasContainerRef.current;
    const video = videoRef.current;

    // Safety check
    if (!container || !video) return;

    // --- CONFIGURATION ---
    const CONFIG = {
      particleCount: 25000,
      colorBase: new THREE.Color("#00ffff"),
      colorCore: new THREE.Color("#ffffff"),
      bloomStrength: 1.2,
      bloomRadius: 0.8,
      lerpSpeed: 0.03,
      fastLerpSpeed: 0.12, // Faster speed during phase transitions
      transitionDuration: 1000, // ms
      camSmooth: 0.08,
      zoomMin: 30,
      zoomMax: 90,
    };

    // --- MUTABLE STATE (Refs pattern for 60FPS loop) ---
    const state = {
      hasHands: false,
      handDistance: 0,
      targetRotX: 0,
      targetRotY: 0,
      targetZoom: 60,
      currentRotX: 0,
      currentRotY: 0,
      currentZoom: 60,
      lastPinchTime: 0,
      pinchCooldown: 1500,
      autoRotateAngle: 0,
      transitionEndTime: 0,
      isBursting: false,
    };

    // --- THREE.JS SETUP ---
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000510, 0.002);

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    camera.position.z = 60;
    camera.position.y = 10;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // --- POST PROCESSING ---
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.5,
      0.4,
      0.85
    );
    bloomPass.strength = CONFIG.bloomStrength;
    bloomPass.radius = CONFIG.bloomRadius;
    composer.addPass(bloomPass);

    // --- GEOMETRY & SHADER ---
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(CONFIG.particleCount * 3);
    const targetPositions = new Float32Array(CONFIG.particleCount * 3);
    const randoms = new Float32Array(CONFIG.particleCount);

    for (let i = 0; i < CONFIG.particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 100;

      targetPositions[i * 3] = positions[i * 3];
      targetPositions[i * 3 + 1] = positions[i * 3 + 1];
      targetPositions[i * 3 + 2] = positions[i * 3 + 2];

      randoms[i] = Math.random();
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aRandom", new THREE.BufferAttribute(randoms, 1));

    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        color: { value: CONFIG.colorBase },
        coreColor: { value: CONFIG.colorCore },
        size: { value: 3.5 * window.devicePixelRatio },
      },
      vertexShader: `
        uniform float time;
        uniform float size;
        attribute float aRandom;
        varying float vAlpha;
        void main() {
            vec3 pos = position;
            // Idle breathing
            pos.x += sin(time * 1.5 + aRandom * 10.0) * 0.15;
            pos.y += cos(time * 1.2 + aRandom * 10.0) * 0.15;
            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            gl_PointSize = size * (30.0 / -mvPosition.z);
            float dist = length(mvPosition.xyz);
            vAlpha = clamp(1.0 - (dist / 120.0), 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform vec3 coreColor;
        varying float vAlpha;
        void main() {
            float r = distance(gl_PointCoord, vec2(0.5));
            if (r > 0.5) discard;
            float glow = 1.0 - (r * 2.0);
            glow = pow(glow, 2.0);
            vec3 finalColor = mix(color, coreColor, glow * 0.6);
            gl_FragColor = vec4(finalColor, vAlpha * glow);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particles = new THREE.Points(geometry, shaderMaterial);
    scene.add(particles);

    // --- FORMATION LOGIC ---
    const formations = [
      {
        name: "SPHERE ANALYSIS",
        func: () => {
          const r = 25;
          for (let i = 0; i < CONFIG.particleCount; i++) {
            const phi = Math.acos(-1 + (2 * i) / CONFIG.particleCount);
            const theta = Math.sqrt(CONFIG.particleCount * Math.PI) * phi;
            targetPositions[i * 3] = r * Math.cos(theta) * Math.sin(phi);
            targetPositions[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
            targetPositions[i * 3 + 2] = r * Math.cos(phi);
          }
        },
      },
      {
        name: "LATTICE GRID",
        func: () => {
          const step = 60 / Math.pow(CONFIG.particleCount, 1 / 3);
          const limit = Math.floor(Math.pow(CONFIG.particleCount, 1 / 3));
          const offset = (limit * step) / 2;
          let c = 0;
          for (let x = 0; x < limit; x++) {
            for (let y = 0; y < limit; y++) {
              for (let z = 0; z < limit; z++) {
                const idx = c * 3;
                if (idx < CONFIG.particleCount * 3) {
                  targetPositions[idx] = x * step - offset;
                  targetPositions[idx + 1] = y * step - offset;
                  targetPositions[idx + 2] = z * step - offset;
                  c++;
                }
              }
            }
          }
        },
      },
      {
        name: "ORBITAL RINGS",
        func: () => {
          for (let i = 0; i < CONFIG.particleCount; i++) {
            const ring = i % 5;
            const r = 10 + ring * 8;
            const theta = Math.random() * Math.PI * 2;
            const thick = (Math.random() - 0.5) * 2;
            targetPositions[i * 3] = Math.cos(theta) * r;
            targetPositions[i * 3 + 1] = (ring - 2) * 2 + thick;
            targetPositions[i * 3 + 2] = Math.sin(theta) * r;
          }
        },
      },
      {
        name: "VORTEX FIELD",
        func: () => {
          for (let i = 0; i < CONFIG.particleCount; i++) {
            const angle = i * 0.02;
            const r = (i / CONFIG.particleCount) * 40;
            const y = (i / CONFIG.particleCount) * 60 - 30;
            targetPositions[i * 3] = Math.cos(angle) * r;
            targetPositions[i * 3 + 1] = y;
            targetPositions[i * 3 + 2] = Math.sin(angle) * r;
          }
        },
      },
    ];

    let currentPhaseIndex = 0;

    function updateFormation() {
      formations[currentPhaseIndex].func();
      
      // Update UI Ref directly
      if (statusPhaseRef.current) {
        statusPhaseRef.current.innerText = formations[currentPhaseIndex].name;
      }
      
      // Flash effect
      bloomPass.strength = 3.5;
      setTimeout(() => {
        bloomPass.strength = CONFIG.bloomStrength;
      }, 300);

      // Set transition timer
      state.transitionEndTime = performance.now() + CONFIG.transitionDuration;
    }

    // --- HAND TRACKING LOGIC ---
    let handLandmarker = null;
    let predictRafId = null;

    const calculateDistance = (p1, p2) => {
      return Math.sqrt(
        Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2)
      );
    };

    const handleGestures = (results) => {
      const lStat = lStatRef.current;
      const rStat = rStatRef.current;
      const cmdStat = cmdStatRef.current;
      const statusMode = statusModeRef.current;

      if (!lStat || !rStat || !cmdStat || !statusMode) return;

      if (results.landmarks.length > 0) {
        state.hasHands = true;
        statusMode.innerText = "MODE: MANUAL CONTROL";
        statusMode.style.color = "#00ff00";

        lStat.innerText = results.landmarks[0] ? "ON" : "--";
        rStat.innerText = results.landmarks[1] ? "ON" : "--";

        const hand1 = results.landmarks[0];
        const hand2 = results.landmarks[1];

        // ONE HAND: Rotation
        if (results.landmarks.length === 1) {
          const x = 1.0 - hand1[9].x; // Middle finger knuckle
          const y = hand1[9].y;

          state.targetRotY = (x - 0.5) * 4.0;
          state.targetRotX = (y - 0.5) * 2.0;

          // PINCH DETECTION
          const pinchDist = calculateDistance(hand1[4], hand1[8]);
          if (pinchDist < 0.05) {
            const now = performance.now();
            if (now - state.lastPinchTime > state.pinchCooldown) {
              currentPhaseIndex = (currentPhaseIndex + 1) % formations.length;
              updateFormation();
              state.lastPinchTime = now;
              cmdStat.innerText = "NEXT PHASE >>";
              cmdStat.style.color = "#ffffff";
            }
          } else {
            cmdStat.innerText = "ROTATING";
            cmdStat.style.color = "#00ffff";
          }
        } 
        // TWO HANDS: Zoom
        else if (results.landmarks.length === 2) {
          const dist = calculateDistance(hand1[0], hand2[0]);
          let normDist = (dist - 0.2) * 2.0;
          normDist = Math.max(0, Math.min(1, normDist));
          
          // Map distance to zoom level (inverted: closer hands = zoom in)
          state.targetZoom = CONFIG.zoomMin + (1 - normDist) * (CONFIG.zoomMax - CONFIG.zoomMin);
          
          cmdStat.innerText = "ZOOMING";
          cmdStat.style.color = "#00ffff";
        }
      } else {
        state.hasHands = false;
        lStat.innerText = "--";
        rStat.innerText = "--";
        cmdStat.innerText = "WAITING";
        cmdStat.style.color = "#00ffff";
        statusMode.innerText = "MODE: AUTO-PILOT";
        statusMode.style.color = "#00ffff";
      }
    };

    const predict = () => {
      if (handLandmarker && video && video.readyState >= 2) {
        const results = handLandmarker.detectForVideo(video, performance.now());
        handleGestures(results);
      }
      predictRafId = requestAnimationFrame(predict);
    };

    const initVision = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );

        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        video.srcObject = stream;
        video.addEventListener("loadeddata", () => {
          predict();
        });
      } catch (err) {
        console.error("MediaPipe Error:", err);
      }
    };

    // --- ANIMATION LOOP ---
    let animateRafId = null;

    const animate = () => {
      const now = performance.now();
      const posArr = particles.geometry.attributes.position.array;

      // 1. Particle Physics
      // Determine speed: fast if transitioning, slow if settled
      const currentLerpSpeed = now < state.transitionEndTime 
        ? CONFIG.fastLerpSpeed 
        : CONFIG.lerpSpeed;

      for (let i = 0; i < CONFIG.particleCount; i++) {
        const ix = i * 3;
        posArr[ix] += (targetPositions[ix] - posArr[ix]) * currentLerpSpeed;
        posArr[ix + 1] += (targetPositions[ix + 1] - posArr[ix + 1]) * currentLerpSpeed;
        posArr[ix + 2] += (targetPositions[ix + 2] - posArr[ix + 2]) * currentLerpSpeed;
      }
      particles.geometry.attributes.position.needsUpdate = true;

      // 2. Camera Physics
      if (state.hasHands) {
        state.currentRotX += (state.targetRotX - state.currentRotX) * CONFIG.camSmooth;
        state.currentRotY += (state.targetRotY - state.currentRotY) * CONFIG.camSmooth;
        state.currentZoom += (state.targetZoom - state.currentZoom) * CONFIG.camSmooth;
        
        // Sync auto-angle so it doesn't snap when hands leave
        state.autoRotateAngle = state.currentRotY;
      } else {
        state.autoRotateAngle += 0.0005 * 10;
        state.targetRotY = state.autoRotateAngle;
        state.targetRotX = 0;
        state.targetZoom = 60;

        state.currentRotX += (state.targetRotX - state.currentRotX) * 0.01;
        state.currentRotY = state.autoRotateAngle * 0.2;
        state.currentZoom += (state.targetZoom - state.currentZoom) * 0.01;
      }

      // 3. Update Camera Position
      const cx = Math.sin(state.currentRotY) * state.currentZoom * Math.cos(state.currentRotX);
      const cy = Math.sin(state.currentRotX) * state.currentZoom;
      const cz = Math.cos(state.currentRotY) * state.currentZoom * Math.cos(state.currentRotX);

      camera.position.set(cx, cy, cz);
      camera.lookAt(0, 0, 0);

      // 4. Render
      shaderMaterial.uniforms.time.value = now * 0.001;
      composer.render();
      
      animateRafId = requestAnimationFrame(animate);
    };

    // Initialize
    updateFormation();
    initVision();
    animate();

    // Resize Handler
    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
      shaderMaterial.uniforms.size.value = 3.5 * window.devicePixelRatio;
    };
    window.addEventListener("resize", handleResize);

    // --- CLEANUP ---
    return () => {
      window.removeEventListener("resize", handleResize);
      if (animateRafId) cancelAnimationFrame(animateRafId);
      if (predictRafId) cancelAnimationFrame(predictRafId);
      
      // Dispose Three.js objects
      geometry.dispose();
      shaderMaterial.dispose();
      renderer.dispose();
      composer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      
      // Stop Video Stream
      if (video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          opacity: 0,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* UI Overlay */}
      <div
        id="ui-layer"
        style={{
          position: "absolute",
          bottom: 40,
          left: 50,
          zIndex: 2,
          color: "#00ffff",
          pointerEvents: "none",
          opacity: 0.9,
          textTransform: "uppercase",
          letterSpacing: "2px",
          fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
        }}
      >
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0, textShadow: "0 0 10px rgba(0,255,255,0.6)" }}>
          J.A.R.V.I.S. // Interface
        </h1>
        <div ref={statusPhaseRef} style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 5 }}>
          INITIALIZING...
        </div>
        <div ref={statusModeRef} style={{ fontSize: 11, color: "#00ffff", marginTop: 2 }}>
          MODE: AUTO-PILOT
        </div>
        <div style={{ width: 50, height: 2, background: "#00ffff", marginTop: 10, boxShadow: "0 0 8px #00ffff", animation: "pulse 2s infinite" }} />
        <style>{`@keyframes pulse { 0% { opacity: 0.3; width: 20px; } 50% { opacity: 1; width: 60px; } 100% { opacity: 0.3; width: 20px; } }`}</style>
      </div>

      {/* HUD Tracker */}
      <div
        className="hud-tracker"
        style={{
          position: "absolute",
          top: 20,
          right: 20,
          width: 160,
          background: "rgba(0,10,20,0.7)",
          border: "1px solid rgba(0,255,255,0.3)",
          borderLeft: "3px solid #00ffff",
          padding: 10,
          fontSize: 10,
          color: "#00ffff",
          fontFamily: "'Courier New', Courier, monospace",
          zIndex: 2,
          boxShadow: "0 0 15px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ opacity: 0.7 }}>SENSORS</span>
          <span style={{ fontWeight: "bold" }}>ACTIVE</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ opacity: 0.7 }}>L-HAND</span>
          <span ref={lStatRef} style={{ fontWeight: "bold" }}>--</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ opacity: 0.7 }}>R-HAND</span>
          <span ref={rStatRef} style={{ fontWeight: "bold" }}>--</span>
        </div>
        <hr style={{ border: 0, borderTop: "1px solid rgba(0,255,255,0.2)", margin: "5px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 0 }}>
          <span style={{ opacity: 0.7 }}>CMD</span>
          <span ref={cmdStatRef} style={{ fontWeight: "bold" }}>WAITING</span>
        </div>
      </div>

      <div
        ref={canvasContainerRef}
        style={{
          width: "100vw",
          height: "100vh",
          position: "absolute",
          top: 0,
          left: 0,
          zIndex: 1,
        }}
      />
    </>
  );
};

export default StarkLabGestureCommand;