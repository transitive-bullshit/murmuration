// Instanced billboard particles that morph between two layouts.
//
// Every particle carries "from" and "to" position/color/size/alpha. A single
// progress uniform drives the morph; each particle starts at its own delay so
// the flock sweeps across the scene, and a smooth swirl field lifts particles
// into an arc mid-flight (the "murmuration"). A second, independent channel
// (`aVis`) animates filter/search state: 0 hidden · 0.15 dimmed · 1 normal ·
// 2 highlighted.

export const particleVertex = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute vec3 aColorFrom;
  attribute vec3 aColorTo;
  attribute vec2 aSize;
  attribute vec2 aAlpha;
  attribute vec2 aVis;
  attribute vec2 aMeta;
  attribute float aIndex;

  uniform float uT;
  uniform float uVisT;
  uniform float uTime;
  uniform float uSpread;
  uniform float uSwirl;
  uniform float uGlyphFrom;
  uniform float uGlyphTo;
  uniform float uHover;
  uniform float uSelected;
  uniform float uViewportH;
  uniform float uMinPx;
  uniform float uGain;
  uniform float uShimmer;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlyph;
  varying float vHot;

  float easeInOut(float x) {
    return x < 0.5 ? 16.0 * x * x * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 5.0) / 2.0;
  }

  vec3 flow(vec3 p, float t) {
    return vec3(
      sin(p.y * 1.7 + t) + sin(p.z * 2.3 - t * 0.7),
      sin(p.z * 1.9 - t * 0.8) + sin(p.x * 2.1 + t * 0.6),
      sin(p.x * 1.6 + t * 0.9) + sin(p.y * 2.4 - t * 0.5)
    ) * 0.5;
  }

  void main() {
    float seed = aMeta.x;
    float delay = aMeta.y;
    float p = clamp(uT * (1.0 + uSpread) - delay * uSpread, 0.0, 1.0);
    float e = easeInOut(p);

    vec3 pos = mix(aFrom, aTo, e);
    float arc = sin(3.14159265 * e);
    pos += flow(pos * 0.32 + seed * 6.0, uTime * 0.5 + seed * 9.0) * arc * uSwirl;
    pos.y += arc * uSwirl * 0.35 * (seed - 0.3);
    pos += flow(pos * 0.9 + seed * 3.0, uTime * 0.22) * uShimmer;

    float vis = mix(aVis.x, aVis.y, easeInOut(uVisT));
    float shown = smoothstep(0.0, 1.0, vis);
    float hl = clamp(vis - 1.0, 0.0, 1.0);

    float size = mix(aSize.x, aSize.y, e) * mix(0.6, 1.0, shown) * (1.0 + hl * 0.8);
    float alpha = mix(aAlpha.x, aAlpha.y, e) * shown;
    vec3 color = mix(aColorFrom, aColorTo, e) * uGain;
    color = mix(color, color * 1.7 + vec3(0.06, 0.05, 0.03), hl);
    // Highlights never resurrect particles the view itself hides.
    float present = step(0.001, alpha);
    alpha = mix(alpha, max(alpha, 0.95), hl * present);

    float hot = 0.0;
    if (abs(aIndex - uHover) < 0.5) hot = 1.0;
    if (abs(aIndex - uSelected) < 0.5) hot = max(hot, 0.85);
    size *= 1.0 + hot * 1.6;
    color = mix(color, vec3(1.0, 0.93, 0.8) * 2.2, hot * 0.6);
    alpha = mix(alpha, 1.0, hot * present);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    // Keep far particles at least uMinPx tall, fading them rather than
    // letting them shimmer in and out.
    float worldPerPx = (-mv.z) * 2.0 / (uViewportH * projectionMatrix[1][1]);
    float minWorld = uMinPx * worldPerPx;
    float s = max(size, minWorld);
    alpha *= clamp(size / max(minWorld, 1e-6), 0.3, 1.0);
    mv.xy += position.xy * s;
    gl_Position = projectionMatrix * mv;

    vUv = position.xy * 2.0;
    vColor = color;
    vAlpha = alpha;
    vGlyph = mix(uGlyphFrom, uGlyphTo, e);
    vHot = hot;
  }
`

export const particleFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vGlyph;
  varying float vHot;

  void main() {
    vec2 uv = vUv;
    float r = length(uv);

    // Disc: a bright core with a soft halo, like a star.
    float core = smoothstep(0.42, 0.0, r);
    float halo = exp(-r * r * 4.5) * 0.6;
    float disc = clamp(core + halo, 0.0, 1.0) * smoothstep(1.0, 0.8, r);

    // Tile: a rounded square with a faint lit rim and top-down sheen.
    vec2 q = abs(uv) - vec2(0.6);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.24;
    float tile = smoothstep(0.035, -0.035, d);
    float rim = smoothstep(0.08, 0.0, abs(d + 0.07)) * 0.45;
    float sheen = 0.88 + uv.y * 0.12;

    float coverage = mix(disc, tile, vGlyph);
    vec3 lit = mix(vColor * (1.0 + core * 0.9), vColor * sheen + vColor * rim, vGlyph);
    lit += vec3(1.0, 0.95, 0.85) * vHot * core * 0.6;

    float alpha = coverage * vAlpha;
    if (alpha < 0.003) discard;
    if (vGlyph > 0.5 && alpha < 0.35) discard;
    gl_FragColor = vec4(lit, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`
