import {
  Bloom,
  EffectComposer,
  Noise,
  ToneMapping,
  Vignette
} from '@react-three/postprocessing'
import { BlendFunction, ToneMappingMode } from 'postprocessing'

// Note: the composer renders into an MSAA half-float target, where edge
// pixels are shaded with extrapolated varyings. Clamp anything fed to pow()
// or sqrt() in custom shaders, or a single NaN pixel gets smeared across the
// whole frame by the bloom blur.
export function Effects() {
  return (
    <EffectComposer multisampling={4} enableNormalPass={false}>
      <Bloom
        mipmapBlur
        intensity={1.05}
        luminanceThreshold={0.32}
        luminanceSmoothing={0.35}
        radius={0.72}
      />
      <ToneMapping mode={ToneMappingMode.AGX} />
      <Vignette offset={0.22} darkness={0.72} />
      <Noise
        premultiply
        blendFunction={BlendFunction.SOFT_LIGHT}
        opacity={0.22}
      />
    </EffectComposer>
  )
}
