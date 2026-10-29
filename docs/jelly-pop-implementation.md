# Jelly Pop: implementation spec for the HHIL iOS badge app

This document lets an agent rebuild the app's look, motion, sound, haptics and its living jelly avatars from scratch, without the repository. Every number here was copied from the SwiftUI source (`hhil-ios`, the standalone iOS repo; the older copy under `hhil/ios` differs in places and was not used). Code blocks marked **verbatim** are pasted unchanged from the named file and line range; everything else is description. Where the code is ambiguous or contradicts a comment, a **Note** says so.

Target: iOS 26 SDK, SwiftUI, `MeshGradient`, `KeyframeAnimator`, `Color.mix(with:by:)` (iOS 18 API; its default color space is `.perceptual`), Core Haptics, AVAudioEngine. The app is light mode only (`.preferredColorScheme(.light)`) and tinted with `strongInk` (black).

Contents

1. Avatar
2. Flowing aurora background
3. Badge
4. Every animation spring and where it is used
5. Sound
6. Haptics
7. UX flows
8. Tokens recap

Conventions used throughout

* "Radius units": radius 1 is the largest circle that fits the avatar's drawing box. θ = 0 points right and θ grows clockwise, because screen y points down.
* `smooth(x)` is smoothstep on x clamped to 0...1: `c * c * (3 - 2 * c)`.
* `SeededRandom` is a xorshift generator returning 0..<1 (source in section 2).
* All per frame easing is frame rate independent: `k = 1 - exp(-dt * rate)`.

---

## 1. Avatar

### 1.1 Architecture

The avatar is drawn every frame into a SwiftUI `Canvas` inside a `TimelineView(.animation(minimumInterval: 1/60))` (1/30 with Reduce Motion; `paused` when `animated == false`, which list rows use to draw one static frame). Nothing is an image. Three types split the work:

* `AvatarShapeKind`: the body as a polar radius function r(θ) plus face placement per shape. Because every shape is r(θ), two shapes morph by lerping radii and all shapes wobble with the same code.
* `AvatarEngine`: per avatar state machine advanced once per frame. It returns a `Frame` (morph progress, face params, blink, gaze, hop, squash, breathe, idle pose, jelly output). Layers bottom to top: shape morph, expression easing, idle life (breathing, wobble, hops, blinks, saccades), attention (look target), idle activities (`IdleDirector`), jelly body (`JellyBody`, phone motion physics).
* `AvatarRenderer`: pure drawing of a `Frame` (lives in `AvatarView.swift`).

On top of that, `AvatarStage` (badge only) adds touch: drag to squish and lean, tap to hop, and the two avatar "meet" choreography.

`AvatarView(shape:color:expression:look:animated:seed:)` is the public view. It is `.aspectRatio(1, contentMode: .fit)`. `look` is a point in -1...1 per axis (nil lets the eyes wander). `seed` makes each avatar's timing unique (`AvatarStyle.seed(id)` hashes the user id: `id.unicodeScalars.reduce(7) { ($0 &* 31 &+ Int($1.value)) & 0x7FFF_FFFF }`). An environment flag `avatarSensesMotion` (true only for the wearer's own idle badge avatar) feeds the phone's motion into the engine; when on, the view calls `motion.start()` in a `.task` and `motion.stop()` on cancel.

Accessibility label: `"\(shape.displayName) avatar, \(expression.rawValue)"`.

### 1.2 Shapes: exact polar radius functions

Seven shapes: `blob, puzzle, circle, triangle, square, pill, flower` (display names are the capitalized raw values; unknown server strings fall back to `.blob`). `phase` is `time * 0.9` (seconds since reference date times 0.9).

| Shape | Base radius r(θ) |
|---|---|
| circle | `0.9` |
| blob | `(0.88 + 0.05 sin(3θ + phase) + 0.035 sin(5θ − 0.7 phase) + 0.03 cos 2θ) × flat`, where `flat = 1 − 0.1 sin⁴θ` when `sin θ > 0` (lower half, flatter bottom) else `1` |
| square | `0.84 × superellipse(θ, a 1, b 1, n 4.5)` |
| pill | `0.95 × superellipse(θ, a 1, b 0.74, n 2.6)` |
| triangle | point up rounded triangle: `u = θ + π/2`, `d = mod(u, 2π/3) − π/3`, `tri = 0.5 / cos d`, `r = 1.12 × (0.8 tri + 0.2 × 0.62)` |
| flower | `0.8 + 0.12 cos(6θ + 0.15 phase)` |
| puzzle | `0.74 × superellipse(θ, 1, 1, 3.4) + 0.22 bump(θ, 0, 0.24) + 0.22 bump(θ, −π/2, 0.24) − 0.1 bump(θ, π, 0.2)` (knobs right and top, a socket left) |

Every shape then adds the shared living wobble: `+ 0.018 sin(2θ + phase) + 0.012 sin(3θ − 1.3 phase)`.

Helpers: `superellipse = 1 / (|cos θ / a|ⁿ + |sin θ / b|ⁿ)^(1/n)`; `bump` is a wrapped Gaussian `exp(−(d / width)²)` with d the signed angular distance in (−π, π]; `positiveMod` is a remainder that is never negative.

Visual center offset (radius units, added to the box center): triangle `(0, 0.18)`, pill `(0, 0.05)`, all others `(0, 0)`.

**Verbatim** (`DesignSystem/Avatar/AvatarShapeKind.swift`):

```swift
// DesignSystem/Avatar/AvatarShapeKind.swift lines 31 to 107
    /// Body radius at angle θ. `phase` slowly advances for the living wobble.
    func radius(_ θ: Double, phase: Double) -> Double {
        let base: Double
        switch self {
        case .circle:
            base = 0.9
        case .blob:
            // Bean like, a little flatter at the bottom (the designer's blobs)
            let flat = sin(θ) > 0 ? 1 - 0.1 * pow(sin(θ), 4) : 1
            base = (0.88 + 0.05 * sin(3 * θ + phase) + 0.035 * sin(5 * θ - 0.7 * phase) + 0.03 * cos(2 * θ)) * flat
        case .square:
            base = 0.84 * Self.superellipse(θ, a: 1, b: 1, n: 4.5)
        case .pill:
            base = 0.95 * Self.superellipse(θ, a: 1, b: 0.74, n: 2.6)
        case .triangle:
            // Rounded triangle, point up. Distance to the nearest edge of a
            // regular triangle, softened toward a circle so the corners are round.
            let period = 2 * Double.pi / 3
            let u = θ + Double.pi / 2
            let d = Self.positiveMod(u, period) - period / 2
            let triangle = 0.5 / cos(d) // circumradius 1
            base = 1.12 * (0.8 * triangle + 0.2 * 0.62)
        case .flower:
            base = 0.8 + 0.12 * cos(6 * θ + 0.15 * phase)
        case .puzzle:
            // Rounded square with two knobs (right and top), like the designer's piece
            let square = 0.74 * Self.superellipse(θ, a: 1, b: 1, n: 3.4)
            let right = Self.bump(θ, at: 0, width: 0.24)
            let top = Self.bump(θ, at: -Double.pi / 2, width: 0.24)
            let socket = Self.bump(θ, at: Double.pi, width: 0.2)
            base = square + 0.22 * right + 0.22 * top - 0.1 * socket
        }
        // Living jelly wobble shared by all shapes
        let wobble = 0.018 * sin(2 * θ + phase) + 0.012 * sin(3 * θ - 1.3 * phase)
        return base + wobble
    }

    /// Where the shape's visual center sits relative to the box center (in radius units).
    var centerOffset: CGPoint {
        switch self {
        case .triangle: return CGPoint(x: 0, y: 0.18)
        case .pill: return CGPoint(x: 0, y: 0.05)
        default: return .zero
        }
    }

    /// Eye positions (radius units from the visual center) and base eye size.
    var eyes: (left: CGPoint, right: CGPoint, size: Double) {
        switch self {
        case .blob: return (CGPoint(x: -0.3, y: -0.22), CGPoint(x: 0.26, y: -0.06), 0.2)
        case .puzzle: return (CGPoint(x: -0.24, y: -0.06), CGPoint(x: 0.2, y: 0.06), 0.21)
        case .triangle: return (CGPoint(x: -0.2, y: 0.1), CGPoint(x: 0.2, y: 0.1), 0.17)
        case .pill: return (CGPoint(x: -0.3, y: -0.1), CGPoint(x: 0.3, y: -0.1), 0.18)
        case .flower: return (CGPoint(x: -0.24, y: -0.08), CGPoint(x: 0.24, y: -0.08), 0.18)
        case .circle, .square: return (CGPoint(x: -0.28, y: -0.12), CGPoint(x: 0.28, y: -0.12), 0.2)
        }
    }

    // MARK: Math helpers

    static func superellipse(_ θ: Double, a: Double, b: Double, n: Double) -> Double {
        let c = pow(abs(cos(θ) / a), n)
        let s = pow(abs(sin(θ) / b), n)
        return 1 / pow(c + s, 1 / n)
    }

    /// Gaussian bump around angle `at`, wrapping around the circle.
    static func bump(_ θ: Double, at center: Double, width: Double) -> Double {
        var d = positiveMod(θ - center + Double.pi, 2 * Double.pi) - Double.pi
        d /= width
        return exp(-d * d)
    }

    static func positiveMod(_ x: Double, _ m: Double) -> Double {
        let r = x.truncatingRemainder(dividingBy: m)
        return r < 0 ? r + m : r
    }
```

### 1.3 Eye placement table

Eye centers are in radius units from the visual center (x right, y down); size is the base eye size in radius units.

| Shape | Left eye | Right eye | Eye size |
|---|---|---|---|
| blob | (−0.30, −0.22) | (0.26, −0.06) | 0.20 |
| puzzle | (−0.24, −0.06) | (0.20, 0.06) | 0.21 |
| triangle | (−0.20, 0.10) | (0.20, 0.10) | 0.17 |
| pill | (−0.30, −0.10) | (0.30, −0.10) | 0.18 |
| flower | (−0.24, −0.08) | (0.24, −0.08) | 0.18 |
| circle | (−0.28, −0.12) | (0.28, −0.12) | 0.20 |
| square | (−0.28, −0.12) | (0.28, −0.12) | 0.20 |

Blob and puzzle eyes are deliberately asymmetric (the designer's blobs). During a morph, eye positions and size lerp from the old shape's values to the new one's with the same eased progress as the radii.

### 1.4 Expressions

An expression is just a target set of continuous `FaceParams`; the engine eases the current face toward the target with `k = 1 − exp(−dt × 8)` (about 250 ms).

`FaceParams` defaults (this is `.idle`): eyeOpen 1, eyeScale 1, crescent 0, bounce 0.012, bounceSpeed 1.4, blush 0, tilt 0, lookBias 0.3.

| Expression | When | eyeOpen | eyeScale | crescent | bounce | bounceSpeed | blush | tilt | lookBias |
|---|---|---|---|---|---|---|---|---|---|
| idle | nobody special near | 1 | 1 | 0 | 0.012 | 1.4 | 0 | 0 | 0.3 |
| sleepy | profile not matchable, idle | 0.32 | 0.95 | 0 | 0.004 | 0.8 | 0 | 0 | 0.3 |
| curious | match in range, closeness ≤ 0.6 | 1 | 1.12 | 0 | 0.02 | 2.2 | 0 | 0.09 | 0.8 |
| excited | match, closeness > 0.6 | 1.05 | 1.25 | 0 | 0.07 | 5.5 | 0 | 0.04 | 1 |
| happy | talking (and 1.4 s after any touch) | 1 | 1.05 | 1 | 0.04 | 3.2 | 0.35 | 0 | 0.6 |
| love | connected (saved each other) | 1 | 1.1 | 1 | 0.05 | 3.8 | 1 | 0 | 0.4 |
| held | finger is down on it | 1.08 | 1.22 | 0 | 0.004 | 2 | 0.3 | 0.06 | 1 |

Meaning of fields: `crescent` 0 is round googly eyes, 1 is happy "◠" arcs. `bounce` is hop height in radius units and `bounceSpeed` is the hop phase rate (radians per second). `tilt` is head tilt in radians multiplied by the gaze x. `lookBias` is how strongly the eyes follow the outside look target versus wandering.

Mapping from badge state (`AvatarTint.expression`): idle mode gives `.idle` if the profile is matchable (has a name and at least one tag) else `.sleepy`; match gives `.excited` when closeness > 0.6 else `.curious`; talking gives `.happy`; connected gives `.love`. `AvatarStage` overrides: `.held` while touching, `.happy` for 1.4 s after a touch ends.

**Verbatim** (`DesignSystem/Avatar/AvatarExpression.swift`):

```swift
// DesignSystem/Avatar/AvatarExpression.swift lines 9 to 58
enum AvatarExpression: String, CaseIterable {
    case idle      // nobody special nearby
    case sleepy    // profile empty, or the app is in the background
    case curious   // a match is in range: lean in, look toward them
    case excited   // the match is getting close
    case happy     // talking
    case love      // saved each other
    case held      // being touched: big eyes on the finger, a little blush, no hopping

    var face: FaceParams {
        switch self {
        case .idle: return FaceParams()
        case .sleepy: return FaceParams(eyeOpen: 0.32, eyeScale: 0.95, crescent: 0, bounce: 0.004, bounceSpeed: 0.8, blush: 0)
        case .curious: return FaceParams(eyeOpen: 1, eyeScale: 1.12, crescent: 0, bounce: 0.02, bounceSpeed: 2.2, tilt: 0.09, lookBias: 0.8)
        case .excited: return FaceParams(eyeOpen: 1.05, eyeScale: 1.25, crescent: 0, bounce: 0.07, bounceSpeed: 5.5, tilt: 0.04, lookBias: 1)
        case .happy: return FaceParams(eyeOpen: 1, eyeScale: 1.05, crescent: 1, bounce: 0.04, bounceSpeed: 3.2, blush: 0.35, lookBias: 0.6)
        case .love: return FaceParams(eyeOpen: 1, eyeScale: 1.1, crescent: 1, bounce: 0.05, bounceSpeed: 3.8, blush: 1, lookBias: 0.4)
        case .held: return FaceParams(eyeOpen: 1.08, eyeScale: 1.22, crescent: 0, bounce: 0.004, bounceSpeed: 2, blush: 0.3, tilt: 0.06, lookBias: 1)
        }
    }
}

/// Continuous face parameters. Everything here can be blended.
struct FaceParams {
    /// 0 closed ... 1 open (blinks multiply this)
    var eyeOpen: Double = 1
    var eyeScale: Double = 1
    /// 0 round googly eyes ... 1 happy crescents (the designer's blob eyes)
    var crescent: Double = 0
    /// Hop height in radius units, and hops per second times 2π
    var bounce: Double = 0.012
    var bounceSpeed: Double = 1.4
    var blush: Double = 0
    /// Head tilt in radians toward where it is looking
    var tilt: Double = 0
    /// How strongly the eyes follow the outside look target (vs wandering)
    var lookBias: Double = 0.3

    /// Move `self` toward `target` by `k` (0...1).
    mutating func approach(_ target: FaceParams, _ k: Double) {
        func lerp(_ a: inout Double, _ b: Double) { a += (b - a) * k }
        lerp(&eyeOpen, target.eyeOpen)
        lerp(&eyeScale, target.eyeScale)
        lerp(&crescent, target.crescent)
        lerp(&bounce, target.bounce)
        lerp(&bounceSpeed, target.bounceSpeed)
        lerp(&blush, target.blush)
        lerp(&tilt, target.tilt)
        lerp(&lookBias, target.lookBias)
    }
```

#### Blink

* A blink starts when `t ≥ nextBlink`. If the idle pose's `blinkRate < 0.05`, it postpones by 0.3 s instead (holding a stare).
* It is a double blink with probability `idle.blinkDouble` (default 0.2).
* Length: `(double ? 0.42 : 0.16) × idle.blinkLength` seconds.
* Shape: `blink = |cos(π p)|` going 1, 0, 1; a double blink runs that twice (`p × 2` modulo 1).
* Next blink: `t + (2 + rand × 4) / max(0.05, blinkRate)`, so every 2 to 6 s at rate 1.
* The eye's drawn openness is `max(0.06, face.eyeOpen × blink)`.

#### Saccades and gaze

Every 0.8 + rand × 2.2 s the wander target jumps to `x ∈ [−0.8, 0.8]`, `y ∈ [−0.5, 0.5]`. The idle activity's gaze replaces the wander target in proportion to the idle weight. With an outside target, `bias = face.lookBias × idle.outside` blends wander toward the target. Gaze follows with `k = 1 − exp(−dt × idle.gazeSpeed)` (default gazeSpeed 14, so fast).

#### Arc eyes, closed eyes, winks, blush, mouth

Drawn by `drawEye` (code in 1.6):

* Round eye: white ellipse `w = 1.25e`, `h = 1.15e × open`. Pupil radius `0.42e × clamp(idle.pupil, 0.4, 1.45)`, offset by `look × (0.32e, 0.26e)`, ink `#1A1A1A`. A catch light (white 0.85, diameter `pr`, at `(px − 0.1pr, py − 0.75pr)`); when `idle.pupil > 1.1` a second small catch light fades in.
* Happy crescent (◠): arc radius `0.62e × max(0.4, open)`, from 200° to 340°, center lowered by `0.45r` and nudged by `look.x × 0.12e`, stroke width `0.38e`, round cap, ink `#111111`.
* Relaxed closed (◡): arc radius `0.55e`, 25° to 155°, center raised `0.4r`, width `0.28e`.
* Wink: per eye, `max(crescent, wink)` turns just that eye into the crescent.
* Cross fades: crescent opacity = crescent; closed opacity = `closed × (1 − crescent)`; round opacity = `(1 − crescent)(1 − closed)`.
* Lids: top lid covers `min(0.95, lidTop + 0.5 squint)` of the eye, filled with the body color, with a slant and a bowed ink edge; bottom lid rises up to 0.8 with a curve (smiling or dreamy). A flat ink lid line appears when `open < 0.5`.
* Dizzy spiral replaces the pupil: 2.6 turns, 30 segments, radius to `0.5e`, spinning at `time × 7` in opposite directions per eye, stroke `0.11e`.
* Blush: two ellipses `1.6e × 0.7e` under each eye at `(eye.x − 0.8e, eye.y + 0.9e)`, color `#FF6C9A` at opacity `0.45 × blush`.
* Smile (idle only): quad curve of width `e × (0.45 + 0.45 smile)`, stroke `0.15e`, fades out as the mouth opens. Mouth "o": ellipse `w = e(0.32 + 0.3m)`, `h = e(0.12 + 0.95m)`, ink; a tongue `#FF8FA8` appears above m 0.4. Mouth center sits at the eyes' midpoint x, `max(l.y, r.y) + 1.05e`.
* Raised brow (`idle.asym`, clamped to −1...1, times 0.18): left eye size × (1 + asym), right × (1 − asym).

### 1.5 The engine: one frame

Order inside `step(time:shape:expression:look:motion:reduceMotion:)`:

1. `dt = clamp(t − lastTime, 0, 0.1)`.
2. Idle weight eases toward 1 in `.idle`, else 0, `k = 1 − exp(−3 dt)`. Body weight is `idleWeight + (1 − idleWeight) × (activity ? 0.35 : 0)` so walking bounce still shows lightly in other expressions.
3. Jelly body step (strength 0.35 with Reduce Motion, dizzy disabled). Its `shock` (startle) and `dizzy` feelings rewrite the idle pose, weighted by idle weight.
4. Shape morph over 0.7 s with `easeOutBack` (c1 = 1.4). An interrupted morph restarts from whichever shape it was closer to.
5. Face eases to the expression (rate 8).
6. Blink, saccade, gaze as above.
7. Hops: `hopPhase += dt × bounceSpeed`; `hop = |sin| × bounce / 0.07` (normalized; Reduce Motion multiplies bounce by 0.3); landing factor `pow(1 − |sin|, 6)`; `squash = bounce × (2.2 landing − 0.8 |cos| (1 − landing)) + idle.squash` (squash on landing, stretch at take off).
8. Breathing: `breathePhase += dt × 1.7 × idle.breatheRate`; `breathe = 1 + (0.018 + idle.breatheDepth) × sin(breathePhase)`.
9. Idle eye modifiers multiply or add onto the face (eyeOpen ×, eyeScale ×, crescent and blush additive with saturation).

**Verbatim** (`DesignSystem/Avatar/AvatarEngine.swift`):

```swift
// DesignSystem/Avatar/AvatarEngine.swift lines 18 to 202
final class AvatarEngine {
    struct Frame {
        var phase: Double
        var morph: (from: AvatarShapeKind, to: AvatarShapeKind, progress: Double)
        var face: FaceParams
        var blink: Double      // 1 open ... 0 closed
        var look: CGPoint      // -1...1
        var hop: Double        // 0...1 height
        var squash: Double     // >0 squashed (wide), <0 stretched (tall)
        var breathe: Double    // scale around 1
        var time: Double       // seconds, for drawn extras
        var idle: IdlePose     // already weighted by how idle the face is
        var jelly: JellyBody.Output
    }

    private var rng: SeededRandom
    private var lastTime: Double?
    private var face = FaceParams()
    private var lookNow = CGPoint.zero
    private var wanderTarget = CGPoint.zero
    private var nextSaccade = 0.0
    private var nextBlink = 0.0
    private var blinkStart: Double?
    private var doubleBlink = false
    private var shapeFrom: AvatarShapeKind
    private var shapeTo: AvatarShapeKind
    private var morphStart = -100.0
    private var hopPhase = 0.0
    private var breathePhase = 0.0
    private let director: IdleDirector
    private var idleWeight = 1.0
    private var jelly = JellyBody()

    init(seed: Int, shape: AvatarShapeKind) {
        rng = SeededRandom(seed: UInt64(truncatingIfNeeded: seed &+ 7))
        shapeFrom = shape
        shapeTo = shape
        director = IdleDirector(seed: seed)
    }

    func step(time t: Double, shape: AvatarShapeKind, expression: AvatarExpression, look target: CGPoint?,
              motion: MotionSnapshot? = nil, reduceMotion: Bool = false) -> Frame {
        let dt = min(0.1, max(0, t - (lastTime ?? t)))
        lastTime = t

        // 5. Idle activity, blended in by how idle the expression is
        idleWeight += ((expression == .idle ? 1 : 0) - idleWeight) * (1 - exp(-dt * 3))
        let raw = director.step(time: t, motion: motion, calm: reduceMotion)
        let bodyWeight = idleWeight + (1 - idleWeight) * (director.kind.isActivity ? 0.35 : 0)
        var idle = IdlePose.mix(IdlePose(), raw, face: idleWeight, body: bodyWeight)

        // 6. Jelly body from the phone's motion, and the faces it causes
        jelly.step(dt: dt, time: t, motion: motion, strength: reduceMotion ? 0.35 : 1, allowDizzy: !reduceMotion)
        let jo = jelly.output
        let shock = jo.shock * idleWeight
        if shock > 0.001 {
            // Startled: eyes pop open with tiny pupils, an "o" mouth, lids fly up
            let calmer = 1 - shock
            idle.lidTop *= calmer
            idle.lidBottom *= calmer
            idle.squint *= calmer
            idle.closed *= calmer
            idle.wink *= calmer
            idle.crescent *= calmer
            idle.eyeScale += (1.32 - idle.eyeScale) * shock
            idle.eyeOpen += (1.2 - idle.eyeOpen) * shock
            idle.pupil += (0.5 - idle.pupil) * shock
            idle.mouth = max(idle.mouth, 0.5 * shock)
            idle.blinkRate *= calmer
            idle.gaze = CGPoint(x: Double(idle.gaze.x) * calmer,
                                y: Double(idle.gaze.y) + (-0.15 - Double(idle.gaze.y)) * shock)
            idle.gazeSpeed = max(idle.gazeSpeed, 28)
            idle.outside *= calmer
        }
        let dizzy = jo.dizzy * idleWeight
        if dizzy > 0.001 {
            // Spinning eyes, a wobbly sway and a wavy little mouth
            let calmer = 1 - dizzy
            idle.spiral = max(idle.spiral, dizzy)
            idle.lidTop = idle.lidTop * calmer + 0.15 * dizzy
            idle.closed *= calmer
            idle.crescent *= calmer
            idle.wink *= calmer
            idle.sway += 0.1 * sin(t * 5) * dizzy
            idle.squash += 0.04 * sin(t * 7.3) * dizzy
            idle.mouth = max(idle.mouth, 0.15 * dizzy)
            idle.blinkRate *= calmer
            idle.outside *= calmer
            idle.gaze = CGPoint(x: Double(idle.gaze.x) * calmer + 0.4 * cos(t * 6) * dizzy,
                                y: Double(idle.gaze.y) * calmer + 0.3 * sin(t * 6) * dizzy)
            idle.gazeSpeed = max(idle.gazeSpeed, 20)
        }

        // 1. Shape morph
        if shape != shapeTo {
            // Interrupted mid morph: start from whichever shape we were closer to.
            let progress = (t - morphStart) / 0.7
            shapeFrom = progress < 0.5 ? shapeFrom : shapeTo
            shapeTo = shape
            morphStart = t
        }
        let morphRaw = min(1, (t - morphStart) / 0.7)
        let morph = Self.easeOutBack(morphRaw)

        // 2. Expression easing (about 250 ms)
        face.approach(expression.face, 1 - exp(-dt * 8))

        // 3a. Blinks every 2 to 6 s, sometimes double
        if blinkStart == nil && t >= nextBlink {
            if idle.blinkRate < 0.05 {
                nextBlink = t + 0.3 // hold the stare
            } else {
                blinkStart = t
                doubleBlink = rng.next() < idle.blinkDouble
            }
        }
        var blink = 1.0
        if let start = blinkStart {
            let length = (doubleBlink ? 0.42 : 0.16) * idle.blinkLength
            let p = (t - start) / length
            if p >= 1 {
                blinkStart = nil
                nextBlink = t + (2 + rng.next() * 4) / max(0.05, idle.blinkRate)
            } else {
                let local = doubleBlink ? (p * 2).truncatingRemainder(dividingBy: 1) : p
                blink = abs(cos(local * .pi)) // 1 -> 0 -> 1
            }
        }

        // 3b. Saccades: jump to a new random gaze point every 0.8 to 3 s
        if t >= nextSaccade {
            wanderTarget = CGPoint(x: rng.next() * 1.6 - 0.8, y: rng.next() * 1.0 - 0.5)
            nextSaccade = t + 0.8 + rng.next() * 2.2
        }

        // 4. Attention blends wander with the outside target
        // The idle activity steers the gaze; the outside target can still pull
        let wander = CGPoint(x: wanderTarget.x + (idle.gaze.x - wanderTarget.x) * idleWeight,
                             y: wanderTarget.y + (idle.gaze.y - wanderTarget.y) * idleWeight)
        let bias = target == nil ? 0 : face.lookBias * idle.outside
        let goal = CGPoint(
            x: wander.x * (1 - bias) + (target?.x ?? 0) * bias,
            y: wander.y * (1 - bias) + (target?.y ?? 0) * bias
        )
        let k = 1 - exp(-dt * idle.gazeSpeed) // eyes move fast unless the activity says otherwise
        lookNow.x += (goal.x - lookNow.x) * k
        lookNow.y += (goal.y - lookNow.y) * k

        // 3c. Hops: |sin| arc, squash on landing, stretch on take off
        hopPhase += dt * face.bounceSpeed
        let s = sin(hopPhase)
        let bounce = face.bounce * (reduceMotion ? 0.3 : 1)
        let hop = abs(s) * bounce / 0.07 // normalized for the drawer
        let landing = pow(1 - abs(s), 6)
        let squash = bounce * (2.2 * landing - 0.8 * abs(cos(hopPhase)) * (1 - landing)) + idle.squash
        breathePhase += dt * 1.7 * idle.breatheRate

        // Idle eye shape on top of the expression
        var shown = face
        shown.eyeOpen *= idle.eyeOpen
        shown.eyeScale *= idle.eyeScale
        shown.crescent = min(1, shown.crescent + idle.crescent * (1 - shown.crescent))
        shown.blush = min(1, shown.blush + idle.blush)

        return Frame(
            phase: t * 0.9,
            morph: (shapeFrom, shapeTo, morph),
            face: shown,
            blink: blink,
            look: lookNow,
            hop: min(1, hop),
            squash: squash,
            breathe: 1 + (0.018 + idle.breatheDepth) * sin(breathePhase),
            time: t,
            idle: idle,
            jelly: jo
        )
    }

    /// Overshoots a little before settling: reads as squishy.
    static func easeOutBack(_ x: Double) -> Double {
        let c1 = 1.4, c3 = c1 + 1
        return 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2)
    }
}
```

### 1.6 Drawing: body, gloss highlight, ground shadow, face, extras

Key numbers (all in `unit = min(w, h) / 2 × 0.86` points, leaving room to hop and squash):

* Lift: `hop × 0.16 + idle.lift` radius units, upward.
* Center: box center + (shape center offset + jelly offset) × unit, minus lift.
* **Ground shadow**: ellipse at `y = h/2 + 0.92 unit`, height `0.12 unit`, width `1.3 unit × (1 − 0.25 up)` where `up = clamp((lift − jelly.offset.y) / 0.16, 0, 1)`; it slides with `jelly.offset.x × 0.6`; fill black at `0.08 × (1 − 0.5 up)`. Drawn before the body, not transformed with it.
* Body transform, in order: translate to center; if jelly stretch > 0.002, rotate to the stretch angle, scale `(1 + s, 1/(1 + s))`, rotate back (volume preserving); rotate by `face.tilt × look.x + idle.sway + jelly.rotation`; scale `x = breathe × (1 + squash)`, `y = breathe × (1 − squash)` with `squash = frame.squash + jelly.squash`.
* Body path: 96 samples of the (morph lerped) radius, joined as a closed smooth path of quadratic curves through midpoints (each sample is a control point). Filled flat with the avatar color. No outline.
* **Gloss highlight**: clipped to the body, an ellipse at `(−0.9u, −1.25u)` size `1.5u × 1.1u`, white at 0.14. That is the whole gloss: a soft top light, no specular dot.
* Face drift: the eyes shift by `look × (0.06u, 0.04u)` for a cheap 3D feel.
* Extras: zzz (three Z strokes rising from the top right over 2.4 s), sigh puff (three white circles), sparkles (three four point stars on the side it looks toward), music notes (two, 1.9 s cycle), wind streaks (three white lines while running), and a fly with wings flapping at `|sin(70t)|`. Zzz, notes, wind and sparkles are drawn in "world" space (translated, not squashed); the fly lives in box space so it does not hop along.

Colors: ink `#1A1A1A`, crescent ink `#111111`, blush `#FF6C9A`, tongue `#FF8FA8`, eye whites and gloss pure white.

**Verbatim** (`DesignSystem/Avatar/AvatarView.swift`, the renderer):

```swift
// DesignSystem/Avatar/AvatarView.swift lines 68 to 443
/// Pure drawing code, separate from timing so it is easy to restyle.
enum AvatarRenderer {
    static let samples = 96
    static let ink = Color(hex: "#1A1A1A")
    static let crescentInk = Color(hex: "#111111")
    static let blushPink = Color(hex: "#FF6C9A")
    static let tongue = Color(hex: "#FF8FA8")

    static func draw(_ f: AvatarEngine.Frame, color: Color, in ctx: inout GraphicsContext, size: CGSize) {
        let unit = min(size.width, size.height) / 2 * 0.86 // leave room to hop and squash
        let lift = f.hop * 0.16 + f.idle.lift
        let hopLift = lift * unit
        let from = f.morph.from, to = f.morph.to, p = f.morph.progress
        let offset = CGPoint(
            x: lerp(from.centerOffset.x, to.centerOffset.x, p),
            y: lerp(from.centerOffset.y, to.centerOffset.y, p)
        )
        let jelly = f.jelly
        let center = CGPoint(x: size.width / 2 + (offset.x + jelly.offset.x) * unit,
                             y: size.height / 2 + (offset.y + jelly.offset.y) * unit - hopLift)
        let idle = f.idle

        // Ground shadow shrinks as it lifts, and slides a little with the jelly
        let up = max(0, min(1, (lift - jelly.offset.y) / 0.16))
        let shadowW = unit * 1.3 * (1 - 0.25 * up)
        ctx.fill(
            Path(ellipseIn: CGRect(x: size.width / 2 + jelly.offset.x * unit * 0.6 - shadowW / 2,
                                   y: size.height / 2 + unit * 0.92,
                                   width: shadowW, height: unit * 0.12)),
            with: .color(.black.opacity(0.08 * (1 - 0.5 * up)))
        )

        // World space extras around the body (not squashed with it)
        var world = ctx
        world.translateBy(x: center.x, y: center.y)
        if idle.wind > 0.01 { drawWind(idle.wind, time: f.time, unit: unit, in: &world) }

        var layer = ctx
        layer.translateBy(x: center.x, y: center.y)
        // Jelly stretch along the way it is moving (keeps its volume)
        if jelly.stretch > 0.002 {
            let a = jelly.stretchAngle
            layer.rotate(by: .radians(a))
            layer.scaleBy(x: 1 + jelly.stretch, y: 1 / (1 + jelly.stretch))
            layer.rotate(by: .radians(-a))
        }
        layer.rotate(by: .radians(f.face.tilt * Double(f.look.x) + idle.sway + jelly.rotation))
        let squash = f.squash + jelly.squash
        layer.scaleBy(x: f.breathe * (1 + squash), y: f.breathe * (1 - squash))

        // Body
        let body = bodyPath(f, unit: unit)
        layer.fill(body, with: .color(color))
        // Soft top light, kept inside the body
        var lit = layer
        lit.clip(to: body)
        lit.fill(
            Path(ellipseIn: CGRect(x: -unit * 0.9, y: -unit * 1.25, width: unit * 1.5, height: unit * 1.1)),
            with: .color(.white.opacity(0.14))
        )

        // Eyes
        let eyesFrom = from.eyes, eyesTo = to.eyes
        let eyeSize = lerp(eyesFrom.size, eyesTo.size, p) * f.face.eyeScale * unit
        let left = CGPoint(x: lerp(eyesFrom.left.x, eyesTo.left.x, p) * unit,
                           y: lerp(eyesFrom.left.y, eyesTo.left.y, p) * unit)
        let right = CGPoint(x: lerp(eyesFrom.right.x, eyesTo.right.x, p) * unit,
                            y: lerp(eyesFrom.right.y, eyesTo.right.y, p) * unit)
        // Whole face drifts slightly toward the gaze (cheap 3D feel)
        let drift = CGPoint(x: f.look.x * unit * 0.06, y: f.look.y * unit * 0.04)
        let l = CGPoint(x: left.x + drift.x, y: left.y + drift.y)
        let r = CGPoint(x: right.x + drift.x, y: right.y + drift.y)
        // A raised brow: one eye a little bigger. A wink closes one into a happy arc.
        let asym = CGFloat(max(-1, min(1, idle.asym))) * 0.18
        drawEye(at: l, size: eyeSize * (1 + asym), inner: 1, wink: max(0, -idle.wink),
                f: f, body: color, in: &layer)
        drawEye(at: r, size: eyeSize * (1 - asym), inner: -1, wink: max(0, idle.wink),
                f: f, body: color, in: &layer)

        // Blush
        if f.face.blush > 0.01 {
            let blush = GraphicsContext.Shading.color(blushPink.opacity(0.45 * f.face.blush))
            for eye in [l, r] {
                let rect = CGRect(x: eye.x - eyeSize * 0.8, y: eye.y + eyeSize * 0.9,
                                  width: eyeSize * 1.6, height: eyeSize * 0.7)
                layer.fill(Path(ellipseIn: rect), with: blush)
            }
        }

        let mc = CGPoint(x: (l.x + r.x) / 2, y: max(l.y, r.y) + eyeSize * 1.05)
        // Smile: a small soft curve, fading out as the mouth opens
        let smile = idle.smile * (1 - min(1, idle.mouth * 3))
        if smile > 0.02 {
            let w = eyeSize * (0.45 + 0.45 * smile)
            var curve = Path()
            curve.move(to: CGPoint(x: mc.x - w / 2, y: mc.y - eyeSize * 0.12))
            curve.addQuadCurve(to: CGPoint(x: mc.x + w / 2, y: mc.y - eyeSize * 0.12),
                               control: CGPoint(x: mc.x, y: mc.y + eyeSize * (0.12 + 0.35 * smile)))
            layer.stroke(curve, with: .color(ink.opacity(min(1, smile * 3))),
                         style: StrokeStyle(lineWidth: eyeSize * 0.15, lineCap: .round))
        }
        // Mouth: a little "o" for humming, gasps and yawns
        if idle.mouth > 0.02 {
            let m = idle.mouth
            let w = eyeSize * (0.32 + 0.3 * m), h = eyeSize * (0.12 + 0.95 * m)
            let mouth = Path(ellipseIn: CGRect(x: mc.x - w / 2, y: mc.y - h / 2, width: w, height: h))
            layer.fill(mouth, with: .color(ink.opacity(min(1, m * 4))))
            if m > 0.4 {
                var inside = layer
                inside.clip(to: mouth)
                inside.fill(Path(ellipseIn: CGRect(x: mc.x - w * 0.35, y: mc.y + h * 0.1, width: w * 0.7, height: h * 0.6)),
                            with: .color(tongue.opacity((m - 0.4) * 1.6)))
            }
        }

        if idle.puff > 0.01 { drawPuff(idle.puff, age: idle.puffAge, at: mc, eye: eyeSize, in: &layer) }
        if idle.sparkle > 0.01 { drawSparkles(idle.sparkle, side: f.look.x >= 0 ? 1 : -1, time: f.time, unit: unit, in: &world) }
        if idle.zzz > 0.01 { drawZzz(idle.zzz, time: f.time, unit: unit, in: &world) }
        if idle.notes > 0.01 { drawNotes(idle.notes, time: f.time, unit: unit, in: &world) }
        if idle.flyAlpha > 0.01 {
            // The fly lives in the box, not on the body, so it does not hop along
            var box = ctx
            box.translateBy(x: size.width / 2, y: size.height / 2)
            drawFly(at: CGPoint(x: idle.fly.x * unit, y: idle.fly.y * unit), alpha: idle.flyAlpha,
                    time: f.time, unit: unit, in: &box)
        }
    }

    /// Closed smooth path through the sampled radii (quad curves through midpoints).
    /// Points are computed on the fly, so nothing is allocated besides the path.
    static func bodyPath(_ f: AvatarEngine.Frame, unit: CGFloat) -> Path {
        let from = f.morph.from, to = f.morph.to, p = f.morph.progress
        func point(_ i: Int) -> CGPoint {
            let θ = Double(i % samples) / Double(samples) * 2 * .pi
            let r = lerp(from.radius(θ, phase: f.phase), to.radius(θ, phase: f.phase), p)
            return CGPoint(x: cos(θ) * r * unit, y: sin(θ) * r * unit)
        }
        func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        let first = point(0)
        var current = first
        var path = Path()
        path.move(to: mid(point(samples - 1), first))
        for i in 0..<samples {
            let next = i + 1 == samples ? first : point(i + 1)
            path.addQuadCurve(to: mid(current, next), control: current)
            current = next
        }
        path.closeSubpath()
        return path
    }

    /// `inner` is the direction toward the nose (+1 for the left eye), for slanted lids.
    /// `wink` (0...1) closes this eye alone into a happy arc.
    static func drawEye(at c: CGPoint, size e: CGFloat, inner: CGFloat, wink: Double, f: AvatarEngine.Frame,
                        body: Color, in ctx: inout GraphicsContext) {
        let idle = f.idle
        let open = max(0.06, f.face.eyeOpen * f.blink)
        let crescent = max(f.face.crescent, wink)
        let closed = max(0, min(1, idle.closed)) * (1 - crescent)
        let roundAmount = (1 - crescent) * (1 - closed)
        let spiral = idle.spiral

        // Round googly eye: white ball, big black pupil that looks around
        if roundAmount > 0.01 {
            var eye = ctx
            eye.opacity = roundAmount
            let w = e * 1.25, h = e * 1.15 * open
            let ball = Path(ellipseIn: CGRect(x: c.x - w / 2, y: c.y - h / 2, width: w, height: h))
            eye.fill(ball, with: .color(.white))
            var inside = eye
            inside.clip(to: ball)
            let pr = e * 0.42 * CGFloat(max(0.4, min(1.45, idle.pupil)))
            let px = c.x + f.look.x * e * 0.32
            let py = c.y + f.look.y * e * 0.26
            if spiral < 0.99 {
                var pupil = inside
                pupil.opacity = 1 - spiral
                pupil.fill(Path(ellipseIn: CGRect(x: px - pr, y: py - pr, width: pr * 2, height: pr * 2)),
                           with: .color(ink))
                // Catch light (a second, smaller one on big dreamy pupils)
                pupil.fill(Path(ellipseIn: CGRect(x: px - pr * 0.1, y: py - pr * 0.75, width: pr * 0.5, height: pr * 0.5)),
                           with: .color(.white.opacity(0.85)))
                if idle.pupil > 1.1 {
                    let k = min(1, (idle.pupil - 1.1) * 4)
                    pupil.fill(Path(ellipseIn: CGRect(x: px - pr * 0.55, y: py + pr * 0.2, width: pr * 0.24, height: pr * 0.24)),
                               with: .color(.white.opacity(0.7 * k)))
                }
            }
            // Dizzy: a turning spiral instead of the pupil
            if spiral > 0.01 {
                var swirl = inside
                swirl.opacity = spiral
                var path = Path()
                let turns = 2.6, steps = 30
                let spin = f.time * 7 * Double(inner)
                for i in 0...steps {
                    let u = Double(i) / Double(steps)
                    let a = u * turns * 2 * .pi + spin
                    let rad = e * 0.5 * u
                    let pt = CGPoint(x: c.x + cos(a) * rad, y: c.y + sin(a) * rad * Double(min(1, open * 1.1)))
                    if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                }
                swirl.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: e * 0.11, lineCap: .round, lineJoin: .round))
            }
            // Top lid: half lids, sleepy droop, suspicious or sad slants, the
            // determined squint. The edge bows down a little, like a real lid.
            let cover = min(0.95, idle.lidTop + 0.5 * idle.squint)
            if cover > 0.01 {
                let slant = (idle.lidSlant + 0.48 * idle.squint) * min(1, cover * 4)
                let top = c.y - h / 2
                let outerY = top + h * CGFloat(max(0, min(1, cover - 0.25 * slant)))
                let innerY = top + h * CGFloat(max(0, min(1, cover + 0.25 * slant)))
                let outerX = c.x - inner * w * 0.6, innerX = c.x + inner * w * 0.6
                let bow = h * 0.1 * CGFloat(min(1, cover * 3))
                let control = CGPoint(x: c.x, y: (outerY + innerY) / 2 + bow)
                var lid = Path()
                lid.move(to: CGPoint(x: outerX, y: top - e))
                lid.addLine(to: CGPoint(x: innerX, y: top - e))
                lid.addLine(to: CGPoint(x: innerX, y: innerY))
                lid.addQuadCurve(to: CGPoint(x: outerX, y: outerY), control: control)
                lid.closeSubpath()
                inside.fill(lid, with: .color(body))
                var edge = Path()
                edge.move(to: CGPoint(x: outerX, y: outerY))
                edge.addQuadCurve(to: CGPoint(x: innerX, y: innerY), control: control)
                inside.stroke(edge, with: .color(ink.opacity(min(1, cover * 3))), lineWidth: e * 0.12)
            }
            // Bottom lid: rises with a curve up, for smiling and dreamy eyes
            if idle.lidBottom > 0.01 {
                let b = CGFloat(min(0.8, idle.lidBottom))
                let bottom = c.y + h / 2
                let y = bottom - h * b
                var lid = Path()
                lid.move(to: CGPoint(x: c.x - w, y: bottom + e))
                lid.addLine(to: CGPoint(x: c.x + w, y: bottom + e))
                lid.addLine(to: CGPoint(x: c.x + w * 0.6, y: y + h * b * 0.35))
                lid.addQuadCurve(to: CGPoint(x: c.x - w * 0.6, y: y + h * b * 0.35),
                                 control: CGPoint(x: c.x, y: y - h * b * 0.6))
                lid.closeSubpath()
                inside.fill(lid, with: .color(body))
            }
            // Sleepy lid line when nearly closed
            if open < 0.5 {
                var lid = Path()
                lid.move(to: CGPoint(x: c.x - w / 2, y: c.y - h / 2))
                lid.addLine(to: CGPoint(x: c.x + w / 2, y: c.y - h / 2))
                eye.stroke(lid, with: .color(ink), style: StrokeStyle(lineWidth: e * 0.14, lineCap: .round))
            }
        }

        // Relaxed closed eye, a soft "◡" (content, sighing, asleep)
        if closed > 0.01 {
            var eye = ctx
            eye.opacity = closed
            var arc = Path()
            let r = e * 0.55
            arc.addArc(center: CGPoint(x: c.x, y: c.y - r * 0.4), radius: r,
                       startAngle: .degrees(25), endAngle: .degrees(155), clockwise: false)
            eye.stroke(arc, with: .color(ink), style: StrokeStyle(lineWidth: e * 0.28, lineCap: .round))
        }

        // Happy crescent eye, the designer's "◠" mark (also the winking eye)
        if crescent > 0.01 {
            var eye = ctx
            eye.opacity = crescent
            var arc = Path()
            let r = e * 0.62
            let o = max(open, wink)
            let lift = (1 - o) * e * 0.2
            arc.addArc(center: CGPoint(x: c.x + f.look.x * e * 0.12, y: c.y + r * 0.45 + lift),
                       radius: r * max(0.4, o),
                       startAngle: .degrees(200), endAngle: .degrees(340), clockwise: false)
            eye.stroke(arc, with: .color(crescentInk), style: StrokeStyle(lineWidth: e * 0.38, lineCap: .round))
        }
    }

    // MARK: Idle extras

    /// Three Z's drifting up and away from the top right of the head.
    static func drawZzz(_ amount: Double, time: Double, unit: CGFloat, in ctx: inout GraphicsContext) {
        for i in 0..<3 {
            let p = (time / 2.4 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
            let s = unit * (0.1 + 0.09 * p)
            let x = unit * (0.5 + 0.35 * p) + sin(p * 6 + Double(i)) * unit * 0.04
            let y = -unit * (0.65 + 0.55 * p)
            var z = Path()
            z.move(to: CGPoint(x: x - s / 2, y: y - s / 2))
            z.addLine(to: CGPoint(x: x + s / 2, y: y - s / 2))
            z.addLine(to: CGPoint(x: x - s / 2, y: y + s / 2))
            z.addLine(to: CGPoint(x: x + s / 2, y: y + s / 2))
            ctx.stroke(z, with: .color(ink.opacity(0.6 * amount * sin(.pi * p))),
                       style: StrokeStyle(lineWidth: s * 0.2, lineCap: .round, lineJoin: .round))
        }
    }

    /// A small breath cloud drifting out of the mouth and fading (a sigh).
    static func drawPuff(_ amount: Double, age: Double, at mouth: CGPoint, eye e: CGFloat,
                         in ctx: inout GraphicsContext) {
        let fade = amount * sin(.pi * max(0, min(1, age)))
        guard fade > 0.01 else { return }
        let shade = GraphicsContext.Shading.color(.white.opacity(0.7 * fade))
        for i in 0..<3 {
            let k = CGFloat(i)
            let d = CGFloat(age) * e * (1.6 + k * 0.5)
            let r = e * (0.16 + 0.1 * k) * (0.6 + CGFloat(age))
            let x = mouth.x + e * 0.4 + d, y = mouth.y + e * 0.1 - d * 0.35 + k * e * 0.05
            ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)), with: shade)
        }
    }

    /// Little four point sparkles twinkling above, on the side it is dreaming toward.
    static func drawSparkles(_ amount: Double, side: CGFloat, time: Double, unit: CGFloat,
                             in ctx: inout GraphicsContext) {
        for i in 0..<3 {
            let k = Double(i)
            let tw = 0.5 + 0.5 * sin(time * (2.2 + k * 0.7) + k * 2.1)
            let s = unit * (0.05 + 0.035 * CGFloat(tw))
            let x = side * unit * (0.45 + 0.28 * CGFloat(k)), y = -unit * (0.95 + 0.18 * CGFloat(i % 2)) + unit * 0.1 * CGFloat(k)
            var star = Path()
            star.move(to: CGPoint(x: x, y: y - s))
            star.addQuadCurve(to: CGPoint(x: x + s, y: y), control: CGPoint(x: x, y: y))
            star.addQuadCurve(to: CGPoint(x: x, y: y + s), control: CGPoint(x: x, y: y))
            star.addQuadCurve(to: CGPoint(x: x - s, y: y), control: CGPoint(x: x, y: y))
            star.addQuadCurve(to: CGPoint(x: x, y: y - s), control: CGPoint(x: x, y: y))
            ctx.fill(star, with: .color(.white.opacity(0.9 * amount * (0.35 + 0.65 * tw))))
        }
    }

    /// Two music notes floating out to either side.
    static func drawNotes(_ amount: Double, time: Double, unit: CGFloat, in ctx: inout GraphicsContext) {
        for i in 0..<2 {
            let side: CGFloat = i == 0 ? 1 : -1
            let p = (time / 1.9 + Double(i) * 0.5).truncatingRemainder(dividingBy: 1)
            let x = side * unit * (0.7 + 0.3 * p) + sin(p * 9) * unit * 0.05
            let y = -unit * (0.35 + 0.6 * p)
            let w = unit * 0.11, h = unit * 0.08
            let shade = GraphicsContext.Shading.color(ink.opacity(0.6 * amount * sin(.pi * p)))
            ctx.fill(Path(ellipseIn: CGRect(x: x - w / 2, y: y - h / 2, width: w, height: h)), with: shade)
            var stem = Path()
            stem.move(to: CGPoint(x: x + w * 0.42, y: y))
            stem.addLine(to: CGPoint(x: x + w * 0.42, y: y - unit * 0.22))
            stem.addLine(to: CGPoint(x: x + w * 1.1, y: y - unit * 0.16))
            ctx.stroke(stem, with: shade, style: StrokeStyle(lineWidth: unit * 0.025, lineCap: .round, lineJoin: .round))
        }
    }

    /// Streaks rushing past while running.
    static func drawWind(_ amount: Double, time: Double, unit: CGFloat, in ctx: inout GraphicsContext) {
        for i in 0..<3 {
            let speed = 0.55 + Double(i) * 0.12
            let p = (time / speed + Double(i) * 0.37).truncatingRemainder(dividingBy: 1)
            let y = unit * (CGFloat(i) * 0.42 - 0.45)
            let x = unit * (1.25 - 2.5 * p)
            var streak = Path()
            streak.move(to: CGPoint(x: x, y: y))
            streak.addLine(to: CGPoint(x: x + unit * 0.38, y: y))
            ctx.stroke(streak, with: .color(.white.opacity(0.6 * amount * sin(.pi * p))),
                       style: StrokeStyle(lineWidth: unit * 0.035, lineCap: .round))
        }
    }

    /// A tiny fly with buzzing wings.
    static func drawFly(at c: CGPoint, alpha: Double, time: Double, unit: CGFloat, in ctx: inout GraphicsContext) {
        var fly = ctx
        fly.opacity = alpha
        let r = unit * 0.035
        let flap = 0.55 + 0.45 * abs(sin(time * 70))
        let wing = GraphicsContext.Shading.color(.white.opacity(0.85))
        fly.fill(Path(ellipseIn: CGRect(x: c.x - r * 1.9, y: c.y - r * 1.5 * flap, width: r * 1.6, height: r * 1.5 * flap)), with: wing)
        fly.fill(Path(ellipseIn: CGRect(x: c.x + r * 0.3, y: c.y - r * 1.5 * flap, width: r * 1.6, height: r * 1.5 * flap)), with: wing)
        fly.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r * 0.8, width: r * 2, height: r * 1.6)), with: .color(ink))
    }

    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
    static func lerp(_ a: CGFloat, _ b: CGFloat, _ t: Double) -> CGFloat { a + (b - a) * CGFloat(t) }
}
```

### 1.7 Jelly physics from the phone's motion

`JellyBody` is a few damped springs driven by the raw accelerometer and gyro (CoreMotion device motion at 60 Hz). The body lags behind when the phone accelerates, overshoots, wobbles, stretches along its velocity, squashes when pushed toward the face and counter rotates when the phone spins.

| Spring | ω | damping ζ | Notes |
|---|---|---|---|
| translation | 2π × 2.0 | 0.2 | input gain 42 (radius units per g × ω²); stiffens by `1 + 25(x² + y²)` so it cannot fly off |
| squash ("jig") | 2π × 3.2 | 0.14 | driven by `accelZ × 60 × strength`; a jolt adds `2.5 × joltStrength × strength` to its velocity |
| rotation | 2π × 1.6 | 0.22 | relative to `spin × 0.5 × strength` (gyro z) |

Input: dead zone 0.012 g per axis, y negated (device y points up), samples older than 0.25 s count as zero, a light low pass `1 − exp(−45 dt)`. Integration uses substeps of at most 1/120 s.

Outputs: `offset = 0.22 tanh(x / 0.22)` (same for y), `stretch = 0.16 tanh(0.65 × speed)` along `atan2(vy, vx)`, `squash = clamp(jig + 0.6 y, −0.18, 0.18)`, `rotation = clamp(−angle + 0.9 offset.x, −0.35, 0.35)`.

Feelings: `shock` jumps to the jolt strength (MotionService flags a jolt when user acceleration exceeds 1.1 g, at most every 0.6 s, `strength = min(1, (raw − 1.1)/1.5 + 0.4)`) and decays over 1.1 s. `shakeLoad` integrates `1.6 × max(0, |a| − 0.5)` and leaks at `exp(−0.6 dt)`; dizzy targets `smooth((shakeLoad − 1)/1.2)`, rises at rate 4 and recovers at rate 0.7. Shock is suppressed while dizzy > 0.3. In the engine, shock makes eyes pop (eyeScale toward 1.32, eyeOpen 1.2, tiny pupil 0.5, an "o" mouth 0.5 shock, gaze up −0.15, gazeSpeed ≥ 28, lids up). Dizzy shows spiral eyes, lidTop +0.15, a sway `0.1 sin 5t`, squash `0.04 sin 7.3t`, a small mouth and circling gaze.

**Verbatim** (`DesignSystem/Avatar/JellyBody.swift`):

```swift
// DesignSystem/Avatar/JellyBody.swift lines 16 to 141
struct JellyBody {
    /// What the renderer and the face read, all in radius units / radians.
    struct Output {
        var offset = CGPoint.zero
        /// Stretch along `stretchAngle` (volume kept, so it thins the other way).
        var stretch = 0.0
        var stretchAngle = 0.0
        /// Extra axis aligned squash (> 0 wide) from being pushed into.
        var squash = 0.0
        var rotation = 0.0
        /// 0...1 startle and dizziness.
        var shock = 0.0
        var dizzy = 0.0
    }

    // Translation spring: about 2 Hz, lightly damped so it overshoots
    private static let omega = 2 * Double.pi * 2.0
    private static let damping = 0.2
    /// Radius units per (g of acceleration * ω²): 0.3 g holds about 0.08.
    private static let gain = 42.0
    // Squash spring: faster and bouncier
    private static let jigOmega = 2 * Double.pi * 3.2
    private static let jigDamping = 0.14
    // Rotation spring
    private static let rotOmega = 2 * Double.pi * 1.6
    private static let rotDamping = 0.22

    private var x = 0.0, y = 0.0, vx = 0.0, vy = 0.0
    private var jig = 0.0, jigV = 0.0
    private var angle = 0.0, angV = 0.0
    private var ax = 0.0, ay = 0.0, az = 0.0, spin = 0.0 // filtered input
    private var shockLevel = 0.0
    private var shakeLoad = 0.0
    private var dizzyLevel = 0.0
    private var handledJolt = -1000.0
    private var primed = false

    private(set) var output = Output()

    /// `strength` scales the motion (Reduce Motion passes a small value) and
    /// `allowDizzy` turns the spinning eyes off when motion should stay calm.
    mutating func step(dt: Double, time t: Double, motion m: MotionSnapshot?, strength: Double, allowDizzy: Bool) {
        guard dt > 0 else { return }
        // Inputs, in screen axes (x right, y down). Stale or missing data is zero.
        var inX = 0.0, inY = 0.0, inZ = 0.0, inSpin = 0.0
        if let m, m.available, t - m.sampleTime < 0.25 {
            inX = Self.deadZone(m.accelX, 0.012)
            inY = -Self.deadZone(m.accelY, 0.012) // device y points up the screen
            inZ = Self.deadZone(m.accelZ, 0.012)
            inSpin = m.rotationZ
            if !primed {
                primed = true
                handledJolt = m.lastJolt
            }
            // A sharp jolt: startled, and a kick to the jelly
            if m.lastJolt > handledJolt {
                handledJolt = m.lastJolt
                if t - m.lastJolt < 0.5 {
                    shockLevel = max(shockLevel, m.joltStrength)
                    jigV += 2.5 * m.joltStrength * strength
                }
            }
        }
        // Light low pass so sensor noise does not fizz the outline
        let f = 1 - exp(-dt * 45)
        ax += (inX - ax) * f
        ay += (inY - ay) * f
        az += (inZ - az) * f
        spin += (inSpin - spin) * f

        // Substeps keep the springs stable on a slow frame
        let steps = max(1, Int(ceil(dt / (1.0 / 120))))
        let h = dt / Double(steps)
        let w2 = Self.omega * Self.omega, c = 2 * Self.damping * Self.omega
        let j2 = Self.jigOmega * Self.jigOmega, jc = 2 * Self.jigDamping * Self.jigOmega
        let r2 = Self.rotOmega * Self.rotOmega, rc = 2 * Self.rotDamping * Self.rotOmega
        let g = Self.gain * strength
        for _ in 0..<steps {
            // The phone accelerates one way, the body is left behind the other way.
            // Stiffens past about 0.15 so a hard swing cannot fling it off the badge.
            let stiff = 1 + 25 * (x * x + y * y)
            vx += (-w2 * stiff * x - c * vx - ax * g) * h
            vy += (-w2 * stiff * y - c * vy - ay * g) * h
            x += vx * h
            y += vy * h
            // Pushed toward the face (phone moving out of the screen) it squashes flat
            jigV += (-j2 * jig - jc * jigV + az * 60 * strength) * h
            jig += jigV * h
            // Body angle relative to the phone: the phone spins, the body tries to stay put
            let rel = angV - spin * 0.5 * strength
            angV += (-r2 * angle - rc * rel) * h
            angle += rel * h
        }

        // Feelings
        shockLevel = max(0, shockLevel - dt / 1.1)
        let shaking = sqrt(ax * ax + ay * ay + az * az)
        shakeLoad += dt * 1.6 * max(0, shaking - 0.5)
        shakeLoad *= exp(-dt * 0.6)
        let target = allowDizzy ? Self.smooth((shakeLoad - 1.0) / 1.2) : 0
        // Gets dizzy quickly, comes round slowly
        dizzyLevel += (target - dizzyLevel) * (1 - exp(-dt * (target > dizzyLevel ? 4 : 0.7)))

        let speed = sqrt(vx * vx + vy * vy)
        var o = Output()
        o.offset = CGPoint(x: 0.22 * tanh(x / 0.22), y: 0.22 * tanh(y / 0.22))
        o.stretch = 0.16 * tanh(speed * 0.65)
        o.stretchAngle = atan2(vy, vx)
        // Hanging low it sits heavy (wide), flung up it stretches tall
        o.squash = max(-0.18, min(0.18, jig + y * 0.6))
        // Screen rotation is clockwise positive; the gyro is counter clockwise positive
        o.rotation = max(-0.35, min(0.35, -angle + Double(o.offset.x) * 0.9))
        o.shock = dizzyLevel > 0.3 ? 0 : Self.smooth(shockLevel)
        o.dizzy = dizzyLevel
        output = o
    }

    private static func deadZone(_ v: Double, _ d: Double) -> Double {
        v > d ? v - d : v < -d ? v + d : 0
    }

    private static func smooth(_ x: Double) -> Double {
        let c = max(0, min(1, x))
        return c * c * (3 - 2 * c)
    }
}
```

The motion inputs come from `MotionService` (device motion at 1/60 s; activity from `CMMotionActivityManager` when permitted). Tilt for parallax: `tiltX = clamp(gravity.x × 1.6)`, `tiltY = clamp((gravity.y + 0.6) × 1.6)`, low passed with k 0.065 per sample, published at 30 Hz only when changed by more than 0.002. **Verbatim** (`Core/Motion/MotionService.swift`):

```swift
// Core/Motion/MotionService.swift lines 104 to 208
    private func update(_ m: CMDeviceMotion) {
        let now = Date.timeIntervalSinceReferenceDate
        let k = 0.065 // low pass (tuned for 60 Hz, same feel as 0.12 at 30 Hz)
        let x = max(-1, min(1, m.gravity.x * 1.6))
        let y = max(-1, min(1, (m.gravity.y + 0.6) * 1.6)) // upright phone reads about -0.6
        smoothTiltX += (x - smoothTiltX) * k
        smoothTiltY += (y - smoothTiltY) * k
        let a = m.userAcceleration
        let raw = sqrt(a.x * a.x + a.y * a.y + a.z * a.z) // in g
        let magnitude = min(1, raw * 2.5)
        let e = energy + (magnitude - energy) * (magnitude > energy ? 0.16 : 0.02)
        tiltTick &+= 1
        if tiltTick % 2 == 0 {
            if abs(smoothTiltX - tiltX) > 0.002 { tiltX = smoothTiltX }
            if abs(smoothTiltY - tiltY) > 0.002 { tiltY = smoothTiltY }
            if abs(e - energy) > 0.004 { energy = e }
        }

        var s = snapshot
        s.available = true
        s.energy = e
        // Raw feed for the jelly body (device axes, in g and rad/s)
        s.accelX = a.x
        s.accelY = a.y
        s.accelZ = a.z
        s.rotationZ = m.rotationRate.z
        s.sampleTime = now
        s.gravityX = m.gravity.x
        s.gravityY = m.gravity.y
        s.gravityZ = m.gravity.z

        // Stillness: any real movement resets the clock
        if raw > 0.035 { s.stillSince = now }

        // Jolt: one sharp spike (bumped, tapped hard, dropped into a hand)
        if raw > 1.1 && now - s.lastJolt > 0.6 {
            s.lastJolt = now
            s.joltStrength = min(1, (raw - 1.1) / 1.5 + 0.4)
        }

        // Shake: strong acceleration that keeps flipping direction
        let dot = a.x * lastAccel.x + a.y * lastAccel.y + a.z * lastAccel.z
        lastAccel = a
        if raw > 0.9 && dot < 0 { shakeLoad += 1 }
        shakeLoad *= 0.965 // per sample at 60 Hz (0.93 at 30 Hz)
        if shakeLoad > 4.5 {
            s.lastShake = now
            shakeLoad = 0
        }

        // Steps: vertical acceleration (along gravity) rising through a threshold
        let v = -(a.x * m.gravity.x + a.y * m.gravity.y + a.z * m.gravity.z)
        vertical += (v - vertical) * 0.28 // 60 Hz
        if vertical < -0.04 { verticalArmed = true }
        if verticalArmed && vertical > 0.08 {
            verticalArmed = false
            let gap = now - s.lastStep
            if gap > 0.24 && gap < 1.4 {
                s.stepInterval += (gap - s.stepInterval) * 0.3
                s.stepCount = min(s.stepCount + 1, 1000)
            } else if gap >= 1.4 {
                s.stepCount = 0
            }
            if gap > 0.24 { s.lastStep = now }
        }
        if now - s.lastStep > 1.6 { s.stepCount = 0 }
        snapshot = s
    }
}

/// A plain value copy of what the phone is doing. Times are seconds since the
/// reference date, the same clock the avatar's TimelineView uses.
struct MotionSnapshot {
    enum Activity { case unknown, stationary, walking, running, cycling, automotive }

    var available = false
    var activity: Activity = .unknown
    var activityConfidence = 0.0
    var energy = 0.0
    var gravityX = 0.0
    var gravityY = -1.0
    var gravityZ = 0.0
    var stillSince = 0.0
    var lastJolt = -1000.0
    var joltStrength = 0.0
    var lastShake = -1000.0
    var lastStep = -1000.0
    var stepInterval = 0.55
    /// Steps in a row with a steady rhythm (0 when the rhythm breaks).
    var stepCount = 0
    /// Latest user acceleration (g, device axes: x right, y toward the top of
    /// the screen, z out of the screen) and spin around the screen normal (rad/s).
    var accelX = 0.0
    var accelY = 0.0
    var accelZ = 0.0
    var rotationZ = 0.0
    var sampleTime = -1000.0

    /// Screen toward the floor (lying face down, or the badge flipped around).
    var faceDown: Bool { gravityZ > 0.75 }
    /// Phone hanging upside down.
    var upsideDown: Bool { gravityY > 0.65 }
    /// Walking found from steps alone, for when activity is unavailable.
    var stepping: Bool { stepCount >= 4 }
}
```

### 1.8 Idle director: what it does when nobody is near

The director picks "activities" that add an `IdlePose` (gaze, lids, winks, pupils, lift, sway, squash, breathing, extras). Summary:

* Start: a random ambient activity, backdated by up to 2 s so avatars never start in sync.
* Ambient cycle: when an activity's duration ends, pick a new one by weight, never one of the last three, cross fading 0.75 s from exactly what was on screen.
* Motion driven: with motion available, a stable reading (1.0 s, or 1.5 s for "nothing") switches to walk, run, car, hang (upside down, gravity y > 0.65) or doze (face down, gravity z > 0.75), fade 0.8 s. Stopping returns to the cycle with fade 0.9 s (from doze it goes to bored first, a stretch and yawn).
* Long stillness: after 60 s still, bored and droop weights triple; after 150 s still and the last pick was bored, it dozes until something moves.
* Reduce Motion: the calm weight set, lift, sway and squash × 0.35, gazeSpeed capped at 8.

| Activity | Weight (calm weight) | Duration s | What it looks like |
|---|---|---|---|
| calm | 1.2 (1.2) | 4 + 3r | near center gaze, occasional slow far look (30%), slight sway |
| stare | 1 (1) | 5 + 3r | stares at you without blinking for 2.2 to 3.6 s, then shy: blush, smile, looks away and down |
| fly | 0.8 (none) | 6 + 3r | a fly buzzes around the head and the eyes chase it |
| reading | 0.8 (1) | 5.5 + 3.5r | gaze steps across lines in 6 stops, quick return, next line lower; squint |
| bored | 0.6 (0.8) | 6 + 3r | sagging half lids, then a big yawn with closed eyes and open mouth |
| hum | 0.9 (none) | 5 + 4r | bobs to a beat 1.4 to 1.9 Hz, crescent eyes, notes float out |
| doubleTake | 0.7 (none) | 4 | glance, look back, snap to the side with big eyes and an "o" |
| peek | 1 (none) | 5 + 3r | suspicious low slanted lids, darts eyes side to side |
| wink | 0.8 (0.8) | 4 + 1.5r | looks at you, winks with a smile, blush and a small hop |
| sigh | 0.9 (1) | 5.5 + 2r | inhales tall, exhales into closed arcs with a breath puff, stays relaxed |
| daydream | 1 (1) | 5 + 4r | looks up and away, big pupils, sparkles |
| curious | 1.1 (1) | 4.5 + 3.5r | puppy head tilts side to side, one eye bigger, flutter blinks |
| droop | 0.7 (none) | 6 + 1.5r | lids sink and head nods, then it snaps awake |
| giggle | 0.8 (none) | 4 + 1.5r | closed happy arcs, rosy cheeks, grin, shaky giggle bursts |
| doze | motion only | until moved | closed arcs, slow deep breaths, zzz, a droopy check every 7 to 11 s |
| walk / run | motion only | while moving | bounces in step (from real step timing), run squints into wind streaks |
| car | motion only | while driving | relaxed sway, watches scenery slide past |
| hang | motion only | upside down | wide eyes, mouth open, pendulum swing |

(r is a seeded random 0..<1 per instance.) All choreography numbers are in the verbatim code below.

**Verbatim** (`DesignSystem/Avatar/IdleDirector.swift`, complete):

```swift
// DesignSystem/Avatar/IdleDirector.swift lines 4 to 686
/// What the idle life adds to the avatar this frame. Every field is a plain
/// number so two poses can be blended, and `IdlePose()` changes nothing.
struct IdlePose {
    /// Where the eyes want to be (-1...1) and how fast they get there.
    var gaze = CGPoint.zero
    var gazeSpeed = 14.0
    /// How much an outside look target (tilt, peer) still pulls the eyes.
    var outside = 1.0
    /// Multipliers on the expression's eyes.
    var eyeOpen = 1.0
    var eyeScale = 1.0
    /// 0...1 flat, slanted top lids (determined squint).
    var squint = 0.0
    /// Eyelids, 0...1 of the eye covered. The top lid comes down (half lids,
    /// sleepy droop), the bottom lid comes up (smiling, dreamy eyes).
    var lidTop = 0.0
    var lidBottom = 0.0
    /// Top lid slant: > 0 lower toward the nose (cross, suspicious),
    /// < 0 lower toward the outside (sad, sleepy, sighing).
    var lidSlant = 0.0
    /// -1 closes the left eye into a happy arc, 1 the right one.
    var wink = 0.0
    /// 0...1 both eyes closed as relaxed "◡" arcs (content, sighing, asleep).
    var closed = 0.0
    /// Pupil size multiplier (big and soft when dreamy, tiny when startled).
    var pupil = 1.0
    /// -1...1 one eye bigger than the other (a raised brow, curious).
    var asym = 0.0
    /// Blink frequency multiplier (0 stops new blinks), blink length multiplier,
    /// and the chance a blink is a double blink.
    var blinkRate = 1.0
    var blinkLength = 1.0
    var blinkDouble = 0.2
    /// Body: lift (radius units, up), sway (radians), extra squash, breathing.
    var lift = 0.0
    var sway = 0.0
    var squash = 0.0
    var breatheDepth = 0.0
    var breatheRate = 1.0
    /// Additive toward the happy crescent eyes and the blush.
    var crescent = 0.0
    var blush = 0.0
    /// Drawn extras, 0...1 each.
    var spiral = 0.0
    var mouth = 0.0
    var smile = 0.0
    var zzz = 0.0
    var notes = 0.0
    var wind = 0.0
    var sparkle = 0.0
    /// A little breath cloud out of the mouth (sigh), and its age 0...1.
    var puff = 0.0
    var puffAge = 0.0
    /// The fly, in radius units from the box center, and how visible it is.
    var fly = CGPoint.zero
    var flyAlpha = 0.0

    /// Blend: face and extras use `face`, body motion uses `body` (0 keeps `a`).
    static func mix(_ a: IdlePose, _ b: IdlePose, face: Double, body: Double) -> IdlePose {
        func m(_ x: Double, _ y: Double, _ k: Double) -> Double { x + (y - x) * k }
        var r = IdlePose()
        r.gaze = CGPoint(x: m(a.gaze.x, b.gaze.x, face), y: m(a.gaze.y, b.gaze.y, face))
        r.gazeSpeed = m(a.gazeSpeed, b.gazeSpeed, face)
        r.outside = m(a.outside, b.outside, face)
        r.eyeOpen = m(a.eyeOpen, b.eyeOpen, face)
        r.eyeScale = m(a.eyeScale, b.eyeScale, face)
        r.squint = m(a.squint, b.squint, face)
        r.lidTop = m(a.lidTop, b.lidTop, face)
        r.lidBottom = m(a.lidBottom, b.lidBottom, face)
        r.lidSlant = m(a.lidSlant, b.lidSlant, face)
        r.wink = m(a.wink, b.wink, face)
        r.closed = m(a.closed, b.closed, face)
        r.pupil = m(a.pupil, b.pupil, face)
        r.asym = m(a.asym, b.asym, face)
        r.blinkRate = m(a.blinkRate, b.blinkRate, face)
        r.blinkLength = m(a.blinkLength, b.blinkLength, face)
        r.blinkDouble = m(a.blinkDouble, b.blinkDouble, face)
        r.lift = m(a.lift, b.lift, body)
        r.sway = m(a.sway, b.sway, body)
        r.squash = m(a.squash, b.squash, body)
        r.breatheDepth = m(a.breatheDepth, b.breatheDepth, body)
        r.breatheRate = m(a.breatheRate, b.breatheRate, body)
        r.crescent = m(a.crescent, b.crescent, face)
        r.blush = m(a.blush, b.blush, face)
        r.spiral = m(a.spiral, b.spiral, face)
        r.mouth = m(a.mouth, b.mouth, face)
        r.smile = m(a.smile, b.smile, face)
        r.zzz = m(a.zzz, b.zzz, face)
        r.notes = m(a.notes, b.notes, face)
        r.wind = m(a.wind, b.wind, face)
        r.sparkle = m(a.sparkle, b.sparkle, face)
        // Like the fly, the puff keeps whichever one is visible instead of sliding
        r.puff = m(a.puff, b.puff, face)
        r.puffAge = b.puff > 0.001 ? b.puffAge : a.puffAge
        // The fly never slides toward the middle: it keeps whichever position is visible.
        r.fly = b.flyAlpha > 0.001 ? b.fly : a.fly
        r.flyAlpha = m(a.flyAlpha, b.flyAlpha, face)
        return r
    }
}

/// Picks and plays the avatar's idle activities, driven by the engine's clock.
///
/// What the wearer does picks the activity (walking bounces in step, running
/// squints into the wind, a car sways, long stillness makes it bored and then
/// doze off). When nothing changes it cycles through ambient activities every
/// 4 to 9 seconds, each with its own face (lids, winks, closed arcs, pupils,
/// tilts, mouth), never repeating one of the last three. Timing and order are
/// seeded per avatar, so two badges never move in sync and nothing reads as a
/// loop. Activities cross fade, so there are no pops. No allocations per frame.
///
/// Jolts and shaking are physical, so the engine's jelly body handles them,
/// whatever the activity is.
final class IdleDirector {
    enum Kind: Equatable {
        // Ambient (cycled when nothing happens)
        case calm, stare, fly, reading, bored, hum, doubleTake
        case peek, wink, sigh, daydream, curious, droop, giggle
        // Long stillness
        case doze
        // Activity
        case walk, run, car, hang

        var isActivity: Bool {
            switch self {
            case .walk, .run, .car, .hang: return true
            default: return false
            }
        }
    }

    private struct Slot {
        var kind: Kind
        var start: Double
        var duration: Double
        var seed: UInt64
        var side: Double // -1 or 1, which way this instance leans
        var a: Double    // 0..<1 per instance variety
        var b: Double
    }

    private var rng: SeededRandom
    private var current: Slot
    private var lastPose = IdlePose()
    private var fadeFrom = IdlePose()
    private var fadeStart = -100.0
    private var fadeLength = 0.9
    private var recent1: Kind = .calm
    private var recent2: Kind = .calm
    private var recent3: Kind = .calm
    private var wanted: Kind?
    private var wantedSince = 0.0
    private var started = false

    init(seed: Int) {
        rng = SeededRandom(seed: UInt64(truncatingIfNeeded: seed &* 31 &+ 101))
        current = Slot(kind: .calm, start: 0, duration: 6, seed: 1, side: 1, a: 0.5, b: 0.5)
    }

    var kind: Kind { current.kind }

    /// `motion` is nil when this avatar does not feel the phone (lists, editors).
    /// `calm` is the Reduce Motion set: fewer, slower activities, smaller moves.
    func step(time t: Double, motion: MotionSnapshot?, calm: Bool) -> IdlePose {
        if !started {
            started = true
            // Start somewhere different per avatar
            begin(pickAmbient(t: t, stillFor: 0, calm: calm), at: t - rng.next() * 2, fade: 0)
        }
        choose(t: t, motion: motion, calm: calm)

        let m = motion ?? MotionSnapshot()
        var out = pose(current, t: t, m: m, calm: calm)
        let f = (t - fadeStart) / fadeLength
        if f < 1 {
            // Blend from exactly what was on screen when the switch happened,
            // so even a switch in the middle of another blend cannot pop.
            let k = Self.smooth(max(0, f))
            out = IdlePose.mix(fadeFrom, out, face: k, body: k)
        }
        if calm {
            out.lift *= 0.35
            out.sway *= 0.35
            out.squash *= 0.35
            out.gazeSpeed = min(out.gazeSpeed, 8)
        }
        lastPose = out
        return out
    }

    // MARK: Choosing

    private func choose(t: Double, motion: MotionSnapshot?, calm: Bool) {
        let kind = current.kind
        guard let m = motion, m.available else {
            if t >= current.start + current.duration {
                begin(pickAmbient(t: t, stillFor: 0, calm: calm), at: t, fade: 0.75)
            }
            return
        }

        // Activity, debounced so a single reading does not flicker the face
        let want = activity(m)
        if want != wanted {
            wanted = want
            wantedSince = t
        }
        let stable = t - wantedSince > (want == nil ? 1.5 : 1.0)
        if let want, want != kind, stable {
            begin(want, at: t, fade: 0.8)
            return
        }
        let stillFor = t - m.stillSince
        if want == nil && stable && (kind.isActivity || (kind == .doze && stillFor < 2)) {
            // Woke up or stopped: a stretch and a yawn, then back to the cycle
            begin(kind == .doze ? .bored : pickAmbient(t: t, stillFor: stillFor, calm: calm), at: t, fade: 0.9)
            return
        }
        if kind == .doze { return } // dozes until something happens
        if t >= current.start + current.duration {
            begin(pickAmbient(t: t, stillFor: stillFor, calm: calm), at: t, fade: 0.75)
        }
    }

    private func activity(_ m: MotionSnapshot) -> Kind? {
        if m.faceDown { return .doze }
        if m.upsideDown { return .hang }
        let sure = m.activityConfidence >= 0.5
        switch m.activity {
        case .running where sure, .cycling where sure: return .run
        case .automotive where sure: return .car
        case .walking where sure: return m.stepping && m.stepInterval < 0.36 ? .run : .walk
        default:
            if m.stepping { return m.stepInterval < 0.36 ? .run : .walk }
            return nil
        }
    }

    private func isRecent(_ k: Kind) -> Bool { k == recent1 || k == recent2 || k == recent3 }

    private func pickAmbient(t: Double, stillFor: Double, calm: Bool) -> Kind {
        // Long stillness: get bored, then doze
        if stillFor > 150 && recent1 == .bored { return .doze }
        let sleepyBoost = stillFor > 60 ? 3.0 : 1.0
        var total = 0.0
        let options: [(Kind, Double)] = calm ? Self.calmWeights : Self.weights
        for (k, w) in options where !isRecent(k) {
            total += (k == .bored || k == .droop) ? w * sleepyBoost : w
        }
        var r = rng.next() * total
        for (k, w) in options where !isRecent(k) {
            r -= (k == .bored || k == .droop) ? w * sleepyBoost : w
            if r <= 0 { return k }
        }
        return .calm
    }

    // Static so picking does not allocate
    private static let weights: [(Kind, Double)] = [
        (.calm, 1.2), (.stare, 1), (.fly, 0.8), (.reading, 0.8), (.hum, 0.9), (.doubleTake, 0.7),
        (.bored, 0.6), (.peek, 1), (.wink, 0.8), (.sigh, 0.9), (.daydream, 1), (.curious, 1.1),
        (.droop, 0.7), (.giggle, 0.8),
    ]
    private static let calmWeights: [(Kind, Double)] = [
        (.calm, 1.2), (.stare, 1), (.reading, 1), (.bored, 0.8), (.daydream, 1), (.curious, 1),
        (.sigh, 1), (.wink, 0.8),
    ]

    private func begin(_ kind: Kind, at t: Double, fade: Double) {
        fadeFrom = lastPose
        fadeStart = t
        fadeLength = max(0.001, fade)
        let r = rng.next()
        let duration: Double
        switch kind {
        case .calm: duration = 4 + r * 3
        case .stare: duration = 5 + r * 3
        case .fly: duration = 6 + r * 3
        case .reading: duration = 5.5 + r * 3.5
        case .bored: duration = 6 + r * 3
        case .hum: duration = 5 + r * 4
        case .doubleTake: duration = 4
        case .peek: duration = 5 + r * 3
        case .wink: duration = 4 + r * 1.5
        case .sigh: duration = 5.5 + r * 2
        case .daydream: duration = 5 + r * 4
        case .curious: duration = 4.5 + r * 3.5
        case .droop: duration = 6 + r * 1.5
        case .giggle: duration = 4 + r * 1.5
        case .doze, .walk, .run, .car, .hang: duration = .infinity
        }
        current = Slot(kind: kind, start: t, duration: duration,
                       seed: UInt64(truncatingIfNeeded: Int(rng.next() * 1_000_000)) &+ 1,
                       side: rng.next() < 0.5 ? -1 : 1, a: rng.next(), b: rng.next())
        if !kind.isActivity && kind != recent1 {
            recent3 = recent2
            recent2 = recent1
            recent1 = kind
        }
    }

    // MARK: Choreography

    private func pose(_ s: Slot, t: Double, m: MotionSnapshot, calm: Bool) -> IdlePose {
        var p = IdlePose()
        let l = max(0, t - s.start) // local time
        // Fade in and out for drawn extras on finite activities
        let edge = s.duration.isFinite ? Self.smooth(min(l, s.duration - l) / 0.6) : Self.smooth(l / 0.6)

        switch s.kind {
        case .calm:
            // Mostly near the middle, sometimes a slow look around
            let seg = 1.8 + s.a * 1.6
            let i = Int(l / seg)
            let far = Self.hash(s.seed, i * 3) < 0.3
            let reach = far ? 0.75 : 0.25
            p.gaze = CGPoint(x: (Self.hash(s.seed, i * 3 + 1) * 2 - 1) * reach,
                             y: (Self.hash(s.seed, i * 3 + 2) * 2 - 1) * reach * 0.6)
            p.gazeSpeed = far ? 4 : 7
            p.sway = 0.02 * sin(l * 0.7 + s.a * 6)

        case .stare:
            // Looks right at you, barely blinking, then gets shy and looks away
            let shyAt = 2.2 + s.a * 1.4
            if l < shyAt {
                p.gaze = CGPoint(x: 0, y: 0.05)
                p.eyeScale = 1.1
                p.pupil = 1.2
                p.blinkRate = 0.1
                p.outside = 0.2
            } else {
                let u = min(1, (l - shyAt) / 0.5)
                let peek = l > s.duration - 1.2
                p.gaze = peek ? CGPoint(x: s.side * 0.25, y: 0.2) : CGPoint(x: s.side * 0.85, y: 0.55)
                p.gazeSpeed = 10
                p.blush = 0.6 * u
                p.lidBottom = 0.3 * u
                p.lidTop = 0.12 * u
                p.lidSlant = -0.4 * u
                p.smile = 0.5 * u
                p.sway = s.side * 0.07 * u
                p.squash = 0.03 * u
                p.outside = 0.2
            }

        case .fly:
            // A fly buzzes around the head, the eyes chase it with a little lag
            let w = 1 + s.a * 0.5
            var x = 0.75 * sin(l * 1.9 * w + s.b * 6) + 0.18 * sin(l * 5.3)
            let y = -0.55 + 0.32 * sin(l * 2.7 * w + s.a * 4) + 0.08 * sin(l * 8.1)
            // Flies in from one side and away to the other
            let arrive = Self.smooth(l / 1.2), leave = Self.smooth((s.duration - l) / 1.2)
            x += s.side * (1 - arrive) * 1.6 - s.side * (1 - leave) * 1.6
            p.fly = CGPoint(x: x, y: y)
            p.flyAlpha = min(arrive, leave)
            p.gaze = CGPoint(x: max(-1, min(1, x / 0.85)), y: max(-1, min(1, (y + 0.1) / 0.8)))
            p.gazeSpeed = 9
            p.outside = 0.1
            p.sway = 0.05 * p.gaze.x
            p.eyeScale = 1.08
            p.pupil = 0.8
            p.mouth = 0.14 * edge
            p.blinkRate = 0.4

        case .reading:
            // Reads lines: steps left to right, quick return, next line lower
            let line = 1.6 + s.a * 0.6
            let li = Int(l / line)
            let u = (l / line) - Double(li)
            let sweep = u < 0.85 ? (floor(u / 0.85 * 6) / 5) : (1 - (u - 0.85) / 0.15)
            p.gaze = CGPoint(x: -0.6 + 1.2 * sweep, y: 0.35 + Double(li % 4) * 0.07)
            p.gazeSpeed = 16
            p.squint = 0.3
            p.lidBottom = 0.18
            p.pupil = 0.85
            p.blinkRate = 0.5
            p.blinkDouble = 0
            p.outside = 0.1
            p.sway = 0.03 * sin(l * 0.5) + (li % 4 == 3 ? 0.04 * s.side : 0)

        case .bored:
            // Flat, sagging half lids, drifting eyes, then a big stretchy yawn
            let yawnAt = 1.4 + s.a * 1.6
            let y = l > yawnAt ? Self.yawn((l - yawnAt) / 2.4) : 0
            p.lidTop = 0.48 * (1 - y)
            p.lidSlant = -0.45
            p.closed = y
            p.gaze = CGPoint(x: 0.4 * sin(l * 0.35 + s.b * 6), y: 0.25 - 0.4 * y)
            p.gazeSpeed = 3
            p.mouth = y
            p.squash = -0.09 * y
            p.lift = 0.03 * y
            p.sway = 0.03 * sin(l * 0.4)
            p.breatheDepth = 0.012
            p.breatheRate = 0.7
            p.blinkLength = 2.2
            p.blinkDouble = 0

        case .doze:
            // Eyes shut in soft arcs, slow deep breaths, zzz, and now and then a droopy check
            let settle = Self.smooth(l / 2.5)
            let checkEvery = 7 + s.a * 4
            let c = l.truncatingRemainder(dividingBy: checkEvery)
            let check = c > checkEvery - 1.3 ? sin((c - (checkEvery - 1.3)) / 1.3 * .pi) : 0
            p.closed = settle * (1 - check)
            p.lidTop = 0.55 * check
            p.lidSlant = -0.4
            p.blinkRate = 1 - settle
            p.gaze = CGPoint(x: 0.1 * s.side, y: 0.45)
            p.gazeSpeed = 2
            p.zzz = settle
            p.breatheDepth = 0.03 * settle
            p.breatheRate = 0.45
            p.sway = 0.07 * s.side * settle
            p.lift = -0.02 * settle

        case .hum:
            // Bobs to a tune it is humming, happy eyes, notes floating out
            let beat = 2 * .pi * (1.4 + s.a * 0.5)
            let half = sin(l * beat * 0.5)
            p.sway = 0.08 * half
            p.lift = 0.04 * abs(half)
            p.squash = 0.03 * pow(1 - abs(half), 4)
            p.crescent = 0.85 * edge
            p.mouth = (0.22 + 0.1 * sin(l * beat)) * edge
            p.notes = edge
            p.blush = 0.25 * edge
            p.gaze = CGPoint(x: 0.25 * half, y: -0.2)
            p.gazeSpeed = 8
            p.outside = 0.3

        case .doubleTake:
            // Glance, look back, then snap right back with big eyes and an "o"
            if l < 0.9 {
                p.gaze = CGPoint(x: s.side * 0.5, y: 0.1)
                p.gazeSpeed = 8
                p.lidTop = 0.2
            } else if l < 1.4 {
                p.gaze = CGPoint(x: 0, y: 0)
                p.gazeSpeed = 10
                p.lidTop = 0.2
            } else {
                let u = min(1, (l - 1.4) / 0.15)
                let hold = Self.smooth((3.4 - l) / 0.6)
                p.gaze = CGPoint(x: s.side * 0.95, y: -0.1)
                p.gazeSpeed = 30
                p.eyeScale = 1 + 0.3 * u * hold
                p.eyeOpen = 1 + 0.12 * hold
                p.pupil = 1 - 0.35 * u * hold
                p.mouth = 0.35 * u * hold
                p.lift = 0.05 * u * Self.smooth((2.8 - l) / 0.5)
                p.sway = s.side * 0.08 * u
                p.blinkRate = 0
            }
            p.outside = 0.1

        case .peek:
            // Suspicious: flat low lids, eyes dart hard to one side, hold, then the other
            let seg = 1.1 + s.a * 0.5
            let i = Int(l / seg)
            let dir = (i % 2 == 0 ? s.side : -s.side)
            let mid = Self.hash(s.seed, i) < 0.25 // sometimes a check straight at you
            p.gaze = mid ? CGPoint(x: 0, y: 0.1) : CGPoint(x: dir * 0.95, y: 0.12)
            p.gazeSpeed = 22
            p.lidTop = 0.42
            p.lidSlant = 0.35
            p.lidBottom = 0.12
            p.pupil = 0.9
            p.blinkRate = 0.25
            p.sway = mid ? 0 : dir * 0.07
            p.lift = -0.015
            p.outside = 0.05

        case .wink:
            // Looks at you, a cheeky wink with a smile and a little hop, then a grin
            let winkAt = 1.0 + s.a * 0.6
            let w = Self.pulse(l - winkAt, rise: 0.1, hold: 0.45, fall: 0.18)
            p.gaze = CGPoint(x: s.side * 0.1, y: 0.05)
            p.gazeSpeed = 10
            p.wink = s.side * w
            p.smile = 0.25 + 0.6 * Self.smooth((l - winkAt + 0.1) / 0.25) * edge
            p.blush = 0.35 * w + 0.15 * edge
            p.lidBottom = 0.25 * Self.smooth((l - winkAt) / 0.4) * edge
            p.lift = 0.05 * w
            p.sway = -s.side * 0.07 * w
            p.squash = -0.03 * w
            p.blinkRate = 0.4
            p.outside = 0.2

        case .sigh:
            // Breathes in tall and wide eyed, then lets it all out: closed arcs,
            // squashes down with a puff, and stays relaxed with heavy lids
            let inhale = Self.smooth(l / 1.1) * (l < 1.3 ? 1 : 0)
            let out = l >= 1.3 ? Self.pulse(l - 1.3, rise: 0.25, hold: 0.9, fall: 0.8) : 0
            let after = Self.smooth((l - 2.6) / 0.8)
            p.lift = 0.04 * inhale - 0.03 * out
            p.squash = -0.06 * inhale + 0.1 * out + 0.02 * after
            p.eyeScale = 1 + 0.06 * inhale
            p.gaze = CGPoint(x: 0, y: -0.45 * inhale + 0.35 * after)
            p.gazeSpeed = 5
            p.closed = out
            p.lidTop = 0.32 * after
            p.lidSlant = -0.5 * after
            p.mouth = 0.22 * out
            p.puff = l >= 1.35 && l < 3.0 ? 1 : 0
            p.puffAge = max(0, min(1, (l - 1.35) / 1.6))
            p.breatheDepth = 0.015
            p.breatheRate = 0.6
            p.blinkLength = 2
            p.blinkRate = 0.5

        case .daydream:
            // Looks up and away at nothing, dreamy big pupils, soft lower lids, sparkles
            let up = Self.smooth(l / 0.9)
            let drift = 0.18 * sin(l * 0.6 + s.b * 5)
            p.gaze = CGPoint(x: s.side * 0.45 + drift, y: -0.8 * up)
            p.gazeSpeed = 3
            p.eyeScale = 1.06
            p.pupil = 1.3
            p.lidBottom = 0.22 * up
            p.smile = 0.3 * up * edge
            p.blush = 0.25 * up
            p.sparkle = up * edge
            p.sway = s.side * 0.05 * up + 0.02 * sin(l * 0.8)
            p.lift = 0.015 * sin(l * 1.2)
            p.blinkLength = 2.4
            p.blinkRate = 0.45
            p.blinkDouble = 0
            p.outside = 0.05

        case .curious:
            // Head tilted, one eye bigger, big pupils, flutter blinks; tilts the
            // other way now and then like a puppy
            let seg = 2.2 + s.a
            let i = Int(l / seg)
            let dir = i % 2 == 0 ? s.side : -s.side
            let k = Self.smooth((l - Double(i) * seg) / 0.35)
            let prev = i == 0 ? 0 : -dir
            let tilt = prev + (dir - prev) * k
            p.sway = 0.17 * tilt
            p.asym = 0.7 * tilt
            p.eyeScale = 1.08
            p.pupil = 1.25
            p.gaze = CGPoint(x: 0.12 * tilt, y: -0.05)
            p.gazeSpeed = 9
            p.blinkDouble = 0.9
            p.blinkRate = 1.4
            p.lift = 0.02 * abs(tilt)
            p.mouth = 0.1 * edge
            p.outside = 0.4

        case .droop:
            // Getting sleepy: lids sink, head nods, nearly gone... then snaps awake
            let wake = 3.8 + s.a * 1.2
            if l < wake {
                let sink = Self.smooth(l / wake)
                let nod = 0.5 + 0.5 * sin(l * 2.3)
                p.lidTop = 0.78 * sink * (0.85 + 0.15 * nod)
                p.lidSlant = -0.35 * sink
                p.lift = -0.035 * sink * nod
                p.squash = 0.04 * sink
                p.sway = s.side * 0.06 * sink
                p.gaze = CGPoint(x: 0, y: 0.45 * sink)
                p.gazeSpeed = 2
                p.blinkRate = 0.2
                p.blinkLength = 3
                p.breatheRate = 0.6
                p.breatheDepth = 0.02 * sink
            } else {
                let pop = 1 - Self.smooth((l - wake) / 1.4)
                p.eyeScale = 1 + 0.22 * pop
                p.eyeOpen = 1 + 0.15 * pop
                p.pupil = 1 - 0.3 * pop
                p.lift = 0.07 * sin(.pi * min(1, (l - wake) / 0.3)) * (l - wake < 0.3 ? 1 : 0)
                p.gaze = (l - wake) < 0.6 ? CGPoint(x: -s.side * 0.6, y: -0.1)
                    : (l - wake) < 1.1 ? CGPoint(x: s.side * 0.6, y: -0.1) : .zero
                p.gazeSpeed = 22
                p.blinkRate = l - wake < 1 ? 0 : 1
                p.blinkDouble = 1
            }
            p.outside = 0.1

        case .giggle:
            // Closed happy arcs, rosy cheeks, a wide grin and a quick shaky giggle
            let burst = Int(l / 1.3) % 2 == 0
            let shake = burst ? sin(l * 34) : 0
            p.crescent = edge
            p.blush = 0.5 * edge
            p.smile = 0.9 * edge
            p.squash = 0.035 * shake
            p.sway = 0.03 * shake + 0.05 * s.side * edge
            p.lift = burst ? 0.02 + 0.015 * abs(shake) : 0
            p.gaze = CGPoint(x: s.side * 0.15, y: 0)
            p.blinkRate = 0
            p.outside = 0.2

        case .walk, .run:
            // Body bounces in step with the wearer, eyes on the road ahead
            let running = s.kind == .run
            let interval = m.stepping ? m.stepInterval : (running ? 0.33 : 0.55)
            let phase: Double
            if m.stepping && t - m.lastStep < 1.2 {
                phase = min(1, (t - m.lastStep) / max(0.2, interval))
            } else {
                phase = (l / interval + s.a).truncatingRemainder(dividingBy: 1)
            }
            let up = sin(.pi * phase)
            p.lift = (running ? 0.08 : 0.055) * up
            p.squash = (running ? 0.07 : 0.05) * pow(1 - phase, 5) - 0.02 * up
            p.gaze = CGPoint(x: 0.08 * sin(l * 0.6), y: running ? 0.1 : -0.05)
            p.gazeSpeed = 10
            p.outside = 0.15
            p.sway = (running ? -0.06 : 0) + 0.025 * sin(.pi * phase) * (Int(l / interval) % 2 == 0 ? 1 : -1)
            if running {
                p.squint = 0.75
                p.eyeScale = 0.95
                p.wind = Self.smooth(l / 0.8)
                p.blinkRate = 0.6
            } else {
                // A cheerful stroll: soft smiling lower lids
                p.eyeScale = 1.03
                p.lidBottom = 0.15
                p.smile = 0.3
            }

        case .car:
            // Relaxed sway, watching the scenery slide past the window
            p.sway = 0.05 * sin(l * 1.1 + s.a * 6) + 0.02 * sin(l * 2.9)
            p.lift = 0.012 * sin(l * 3.7) + 0.008 * sin(l * 9.1)
            let pass = 1.6 + s.b
            let u = (l / pass).truncatingRemainder(dividingBy: 1)
            p.gaze = CGPoint(x: s.side * (0.7 - 1.2 * u), y: 0.12)
            p.gazeSpeed = u < 0.08 ? 24 : 12
            p.lidTop = 0.2
            p.lidSlant = -0.2
            p.crescent = 0.2
            p.outside = 0.1
            p.breatheDepth = 0.006

        case .hang:
            // Upside down: wide eyes, mouth open, swinging like a pendulum
            p.eyeScale = 1.18
            p.eyeOpen = 1.1
            p.pupil = 0.8
            p.gaze = CGPoint(x: 0.2 * sin(l * 1.3), y: -0.85)
            p.gazeSpeed = 8
            p.sway = 0.09 * sin(l * 2.2)
            p.mouth = 0.3
            p.outside = 0
        }
        return p
    }

    // MARK: Helpers

    static func smooth(_ x: Double) -> Double {
        let c = max(0, min(1, x))
        return c * c * (3 - 2 * c)
    }

    /// 0 -> 1 (over `rise`), held for `hold`, back to 0 (over `fall`); x is local time.
    static func pulse(_ x: Double, rise: Double, hold: Double, fall: Double) -> Double {
        if x <= 0 { return 0 }
        if x < rise { return smooth(x / rise) }
        if x < rise + hold { return 1 }
        return 1 - smooth((x - rise - hold) / fall)
    }

    /// 0 -> 1 -> 0 over u in 0...1, held open a moment at the top.
    static func yawn(_ u: Double) -> Double {
        guard u > 0, u < 1 else { return 0 }
        return pow(sin(.pi * u), 0.6)
    }

    /// Stable 0..<1 noise from a seed and an index (splitmix64).
    static func hash(_ seed: UInt64, _ i: Int) -> Double {
        var z = seed &+ UInt64(truncatingIfNeeded: i) &* 0x9E37_79B9_7F4A_7C15
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(1 << 53)
    }
}
```

### 1.9 Touch: poke, drag squish, tap hop (AvatarStage)

The badge's avatar sits in `AvatarStage`, which handles a single `DragGesture(minimumDistance: 0)` measured in the stage's own coordinate space, with a hit shape of `Circle().scale(0.8)`.

Sequence:

1. **Finger down**: `touching = true` with `spring(response 0.18, damping 0.55)`; expression becomes `.held`; cue `avatarPoke` (sound "poke", soft impact 0.55).
2. **Eyes follow the finger**: `look = (finger − home − bodyOffset) / max(0.35 size, 1)` clamped to −1...1.
3. **Drag** (travel > 8 pt): starts the continuous squish voice and squish haptic; each change sends `stretch = d / (d + 0.5 size)` where d is the drag length.
4. **Squish visual** (`Squish` modifier, animatable): rubber band offset `band(d) = d / (1 + |d| / (0.5 size)) × 0.55`; with `soft(v) = v / (1 + |v|)`, `sx = soft(|dx| / size × 1.2)`, `sy = soft(|dy| / size × 1.2)`; scale `x = (1 + 0.32 sx − 0.12 sy)(1 + 0.06 press)`, `y = (1 + 0.32 sy − 0.12 sx)(1 − 0.06 press)`, anchored at the bottom; rotation `soft(dx / size × 1.4) × 18°` around the bottom.
5. **Release**: a tap is "not dragged and held < 0.35 s". Spring back with `spring(0.28, 0.7)` for a tap, or `spring(response 0.5, damping 0.42 − 0.14 stretch)` after a drag (wobblier the further it was pulled). A drag release plays `avatarRelease(stretch)`. A tap increments `boops`, plays `avatarHop`, and 0.5 s later `avatarLand` (only if no newer tap). Then `.happy` for 1.4 s.
6. **Tap hop keyframes**: lift (fraction of size, negative is up): hold 0 for 0.07 s, `SpringKeyframe(-0.22, 0.22 s)`, `SpringKeyframe(0, 0.4 s, .bouncy)`. Squash (1 is rest; applied as `scaleEffect(x: 2 − s, y: s, anchor: .bottom)`): 0.8 at 0.07, 1.14 at +0.18, 1 at +0.14, 0.86 at +0.07, spring to 1 over 0.35 `.bouncy`.

**Verbatim** (`DesignSystem/Badge/AvatarStage.swift`, view body and touch):

```swift
// DesignSystem/Badge/AvatarStage.swift lines 8 to 367
struct AvatarStage: View {
    var avatar: AvatarStyle
    var color: Color
    var expression: AvatarExpression
    var look: CGPoint?
    var followsTilt = false
    var seed: Int
    var peer: AvatarStyle?
    var peerSeed: Int
    var hasMet: Bool
    /// Which side the peer comes from (-1 left, 1 right), from UWB direction.
    var peerSide: Double = 1
    /// Goes up at each meet moment: the leap toward each other and the ripples.
    var meetCount = 0
    var rippleColor: Color = .clear

    @Environment(MotionService.self) private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Touch: drag to squish and lean it, tap to make it hop.
    @State private var drag: CGSize = .zero
    /// Where the finger is relative to the avatar, -1...1 (the eyes follow it).
    @State private var finger: CGPoint?
    @State private var touching = false
    @State private var boops = 0
    @State private var delighted = false
    @State private var delightTask: Task<Void, Never>?
    /// Per touch bookkeeping that should not re-render the view.
    @State private var tracker = TouchTracker()

    private static let space = "avatarStage"

    private var myLook: CGPoint? {
        if touching, let finger { return finger }
        if hasMet { return CGPoint(x: peerSide, y: 0) }
        if let look { return look }
        return followsTilt ? CGPoint(x: motion.tiltX, y: motion.tiltY * 0.6) : nil
    }

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let mySize = hasMet ? size * 0.72 : size
            let home = CGPoint(x: geo.size.width / 2 + (hasMet ? -peerSide * size * 0.2 : 0),
                               y: geo.size.height / 2 + (hasMet ? size * 0.12 : 0))
            ZStack {
                MeetRipples(color: rippleColor, trigger: meetCount)
                    .frame(width: size * 1.6, height: size * 0.5)
                    .offset(y: size * 0.4)

                AvatarView(
                    shape: avatar.shape,
                    color: color,
                    expression: touching ? .held : delighted ? .happy : expression,
                    look: myLook,
                    seed: seed
                )
                .frame(width: mySize, height: mySize)
                .modifier(Squish(drag: drag, press: touching ? 1 : 0, size: mySize))
                .keyframeAnimator(initialValue: Hop(), trigger: boops) { content, hop in
                    content
                        .scaleEffect(x: 2 - hop.squash, y: hop.squash, anchor: .bottom)
                        .offset(y: hop.lift * mySize)
                } keyframes: { _ in
                    KeyframeTrack(\.lift) {
                        CubicKeyframe(0, duration: 0.07)
                        SpringKeyframe(-0.22, duration: 0.22)
                        SpringKeyframe(0, duration: 0.4, spring: .bouncy)
                    }
                    KeyframeTrack(\.squash) {
                        CubicKeyframe(0.8, duration: 0.07)
                        CubicKeyframe(1.14, duration: 0.18)
                        CubicKeyframe(1, duration: 0.14)
                        CubicKeyframe(0.86, duration: 0.07)
                        SpringKeyframe(1, duration: 0.35, spring: .bouncy)
                    }
                }
                .modifier(MeetLeap(trigger: reduceMotion ? 0 : meetCount, side: peerSide, size: mySize))
                .contentShape(Circle().scale(0.8))
                .gesture(touch(size: mySize, home: home))
                .offset(x: hasMet ? -peerSide * size * 0.2 : 0, y: hasMet ? size * 0.12 : 0)

                if hasMet, let peer {
                    AvatarView(
                        shape: peer.shape,
                        color: peer.color,
                        expression: expression,
                        look: CGPoint(x: -peerSide, y: 0),
                        seed: peerSeed
                    )
                    .frame(width: size * 0.66, height: size * 0.66)
                    .modifier(MeetLeap(trigger: reduceMotion ? 0 : meetCount, side: -peerSide, size: size * 0.66, delay: 0.12))
                    .offset(x: peerSide * size * 0.28, y: size * 0.14)
                    .transition(.jumpIn(from: peerSide, distance: size * 1.2, height: size * 0.7))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .coordinateSpace(.named(Self.space))
            .animation(.spring(response: 0.7, dampingFraction: 0.62), value: hasMet)
        }
    }
}

extension AvatarStage {
    /// Under this much travel (points) and time a touch is a tap: hop.
    private static let tapSlop: CGFloat = 8
    private static let tapTime = 0.35

    /// Drag and tap in the stage's own space, so moving the avatar doesn't
    /// move the coordinates the gesture is measured in.
    private func touch(size: CGFloat, home: CGPoint) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space))
            .onChanged { value in
                let t = value.translation
                if !touching {
                    tracker.begin(at: value.time)
                    withAnimation(.spring(response: 0.18, dampingFraction: 0.55)) { touching = true }
                    Feedback.shared.play(.avatarPoke)
                }
                tracker.travel = max(tracker.travel, hypot(t.width, t.height))
                if !tracker.dragging, tracker.travel > Self.tapSlop {
                    tracker.dragging = true
                    Feedback.shared.beginSquish()
                }
                drag = t
                // Eyes on the finger: from where the body is now (it lags behind on the rubber band)
                let body = Squish.bodyOffset(drag: t, size: size)
                let reach = max(size * 0.35, 1)
                finger = CGPoint(x: (value.location.x - home.x - body.width) / reach,
                                 y: (value.location.y - home.y - body.height) / reach).clamped
                if tracker.dragging { Feedback.shared.squish(stretch: Squish.stretch(drag: t, size: size)) }
            }
            .onEnded { value in
                let held = value.time.timeIntervalSince(tracker.start)
                let isTap = !tracker.dragging && held < Self.tapTime
                let stretch = Squish.stretch(drag: value.translation, size: size)
                if tracker.dragging { Feedback.shared.endSquish() }
                tracker.dragging = false

                // Jelly spring back: wobblier the further it was pulled
                let spring: Animation = isTap
                    ? .spring(response: 0.28, dampingFraction: 0.7)
                    : .spring(response: 0.5, dampingFraction: 0.42 - 0.14 * stretch)
                withAnimation(spring) {
                    drag = .zero
                    touching = false
                    finger = nil
                }
                if isTap {
                    boops += 1
                    Feedback.shared.play(.avatarHop)
                    let mark = boops
                    Task {
                        try? await Task.sleep(for: .seconds(0.5)) // the hop lands
                        if boops == mark { Feedback.shared.play(.avatarLand) }
                    }
                } else {
                    Feedback.shared.play(.avatarRelease(stretch: stretch))
                }
                delighted = true
                delightTask?.cancel()
                delightTask = Task {
                    try? await Task.sleep(for: .seconds(1.4))
                    guard !Task.isCancelled else { return }
                    withAnimation { delighted = false }
                }
            }
    }
}

/// Touch bookkeeping kept out of SwiftUI state so it doesn't redraw.
private final class TouchTracker {
    var start = Date()
    var travel: CGFloat = 0
    var dragging = false

    func begin(at time: Date) {
        start = time
        travel = 0
        dragging = false
    }
}

/// The meet leap: crouch, jump toward the other avatar along an arc, land with
/// a heavy squash (when the settling sound hits) and wobble back to rest.
private struct MeetLeap: ViewModifier {
    var trigger: Int
    /// Which way to leap (-1 left, 1 right).
    var side: Double
    var size: CGFloat
    var delay: Double = 0

    func body(content: Content) -> some View {
        content.keyframeAnimator(initialValue: Leap(), trigger: trigger) { content, leap in
            content
                .scaleEffect(x: 2 - leap.squash, y: leap.squash, anchor: .bottom)
                .offset(x: CGFloat(side) * leap.travel * size, y: leap.lift * size)
        } keyframes: { _ in
            KeyframeTrack(\.lift) {
                CubicKeyframe(0, duration: 0.1 + delay)
                CubicKeyframe(-0.3, duration: 0.22)
                CubicKeyframe(0, duration: 0.2)
                SpringKeyframe(0, duration: 0.5, spring: .bouncy)
            }
            KeyframeTrack(\.travel) {
                CubicKeyframe(0, duration: 0.1 + delay)
                CubicKeyframe(0.16, duration: 0.42)
                SpringKeyframe(0, duration: 0.8, spring: .smooth)
            }
            KeyframeTrack(\.squash) {
                CubicKeyframe(0.8, duration: 0.1 + delay)
                CubicKeyframe(1.12, duration: 0.2)
                CubicKeyframe(1, duration: 0.22)
                CubicKeyframe(0.74, duration: 0.07)
                SpringKeyframe(1, duration: 0.6, spring: .bouncy)
            }
        }
    }
}

private struct Leap {
    var lift: CGFloat = 0
    /// Toward the other avatar, as a fraction of size.
    var travel: CGFloat = 0
    var squash: CGFloat = 1
}

/// Rings spreading out over water from where the avatars land, then gone.
private struct MeetRipples: View {
    var color: Color
    var trigger: Int

    var body: some View {
        Color.clear
            .keyframeAnimator(initialValue: Ripple(), trigger: trigger) { _, ripple in
                ZStack {
                    ForEach(0..<3, id: \.self) { i in
                        let p = max(0, min(1, ripple.progress * 1.35 - Double(i) * 0.18))
                        Ellipse()
                            .stroke(color, lineWidth: 2 + 5 * (1 - p))
                            .scaleEffect(0.25 + 0.9 * p)
                            .opacity(ripple.opacity * (1 - p) * (p > 0 ? 1 : 0))
                    }
                }
            } keyframes: { _ in
                KeyframeTrack(\.progress) {
                    LinearKeyframe(0, duration: 0.6)
                    CubicKeyframe(1, duration: 1.7)
                }
                KeyframeTrack(\.opacity) {
                    LinearKeyframe(0, duration: 0.6)
                    LinearKeyframe(0.8, duration: 0.05)
                    CubicKeyframe(0, duration: 1.65)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct Ripple {
    var progress: Double = 0
    var opacity: Double = 0
}

/// Values for the tap hop: lift (fraction of size, negative is up) and squash (1 = rest).
private struct Hop {
    var lift: CGFloat = 0
    var squash: CGFloat = 1
}

/// Follows the finger with a rubber band, leans toward it and stretches along
/// it. Everything saturates, so a long pull never turns into a giant smear.
private struct Squish: ViewModifier, Animatable {
    var drag: CGSize
    /// 0 released ... 1 pressed (squashed down a little), animated with the drag.
    var press: CGFloat
    var size: CGFloat

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, CGFloat> {
        get { AnimatablePair(AnimatablePair(drag.width, drag.height), press) }
        set {
            drag = CGSize(width: newValue.first.first, height: newValue.first.second)
            press = newValue.second
        }
    }

    /// Rubber band: follows 1:2 near the start, flattening out further away.
    static func band(_ d: CGFloat, size: CGFloat) -> CGFloat {
        let reach = max(size, 1) * 0.5
        return d / (1 + abs(d) / reach) * 0.55
    }

    static func bodyOffset(drag: CGSize, size: CGFloat) -> CGSize {
        CGSize(width: band(drag.width, size: size), height: band(drag.height, size: size))
    }

    /// 0...1 how stretched it looks (drives the squish sound and haptics).
    static func stretch(drag: CGSize, size: CGFloat) -> Double {
        let d = hypot(drag.width, drag.height)
        return Double(d / (d + max(size, 1) * 0.5))
    }

    func body(content: Content) -> some View {
        let unit = max(size, 1)
        let soft = { (d: CGFloat) in d / (1 + abs(d)) } // -1...1
        let sx = soft(abs(drag.width) / unit * 1.2)
        let sy = soft(abs(drag.height) / unit * 1.2)
        let squash = 0.06 * press
        let offset = Self.bodyOffset(drag: drag, size: size)
        content
            .scaleEffect(x: (1 + 0.32 * sx - 0.12 * sy) * (1 + squash),
                         y: (1 + 0.32 * sy - 0.12 * sx) * (1 - squash),
                         anchor: .bottom)
            .rotationEffect(.degrees(Double(soft(drag.width / unit * 1.4)) * 18), anchor: .bottom)
            .offset(x: offset.width, y: offset.height)
    }
}

private extension CGPoint {
    var clamped: CGPoint { CGPoint(x: max(-1, min(1, x)), y: max(-1, min(1, y))) }
}

extension AnyTransition {
    /// Enter along a parabola from off to one side, with a spin, like a hop.
    static func jumpIn(from side: Double, distance: CGFloat, height: CGFloat) -> AnyTransition {
        .asymmetric(
            insertion: .modifier(
                active: JumpEffect(progress: 0, side: side, distance: distance, height: height),
                identity: JumpEffect(progress: 1, side: side, distance: distance, height: height)
            ),
            removal: .opacity.combined(with: .scale(scale: 0.6))
        )
    }
}

/// progress 0 = off screen to the side, 1 = landed.
struct JumpEffect: GeometryEffect {
    var progress: Double
    var side: Double
    var distance: CGFloat
    var height: CGFloat

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        let p = max(0, min(1.2, progress))
        let x = CGFloat(side) * distance * CGFloat(1 - p)
        let y = -height * CGFloat(sin(min(1, p) * .pi)) // up, then down
        let spin = CGFloat(side) * CGFloat(1 - min(1, p)) * .pi * 0.5
        var t = CGAffineTransform(translationX: size.width / 2, y: size.height / 2)
        t = t.translatedBy(x: x, y: y)
        t = t.rotated(by: spin)
        t = t.translatedBy(x: -size.width / 2, y: -size.height / 2)
        return ProjectionTransform(t)
    }
}
```

### 1.10 Tinting, and the two avatar color blend when matched

* **My avatar keeps its own color** on the badge: `BadgeConfiguration.avatarColor` returns `avatar.color` unchanged. Proximity tints the badge around it instead.
* `pairColors` is `(mine, theirs)` whenever the mode is not idle, where theirs is the peer's avatar color, or the shared match color from the server when the peer avatar is unknown. Nil when idle.
* `tintStrength = together ? 1 : clamp(closeness, 0, 1)` (0 when there are no pair colors).
* The two colors blend in three places: the PairWash mesh over the background (section 3.5), the identity card surface `white.mix(with: mine.mix(with: theirs, by: 0.5), by: 0.22 × tintStrength)`, and the meet ripple rings in `mine.mix(with: theirs, by: 0.5)` (falls back to my avatar color).
* The peer avatar, when it joins my frame, is drawn in its own color.

**Note (unused code)**: `AvatarTint.color(own:match:closeness:)` still exists (HSB tint: saturation × (0.3 + 0.75c), brightness × (1.08 − 0.3c), then own mixed into it by 0.35 + 0.65c) but nothing calls it. The Badge tab's status text "Your avatar is taking on your shared color" describes that older behavior; the current behavior is the badge wash described here. Reproduce the wash, and keep the status string only if you want parity.

**Verbatim** (`DesignSystem/Avatar/AvatarTint.swift` and `DesignSystem/BadgeStyle.swift` 55 to 72):

```swift
// DesignSystem/Avatar/AvatarTint.swift lines 9 to 30
enum AvatarTint {
    static func color(own: Color, match: Color?, closeness: Double) -> Color {
        guard let match else { return own }
        let c = max(0, min(1, closeness))
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(match).getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        let saturation = s * (0.3 + 0.75 * c)
        let brightness = min(1, b * (1.08 - 0.3 * c))
        let tinted = Color(hue: h, saturation: min(1, saturation), brightness: brightness)
        // Blend from own color into the tint so the change is gradual
        return own.mix(with: tinted, by: 0.35 + 0.65 * c)
    }

    /// The feeling that goes with the badge state.
    static func expression(mode: BadgeMode, closeness: Double, hasProfile: Bool) -> AvatarExpression {
        switch mode {
        case .idle: return hasProfile ? .idle : .sleepy
        case .match: return closeness > 0.6 ? .excited : .curious
        case .talking: return .happy
        case .connected: return .love
        }
    }
```

```swift
// DesignSystem/BadgeStyle.swift lines 55 to 72
    /// The two avatars share one frame (talking or saved).
    var hasMet: Bool { (together || mode == .talking || mode == .connected) && peerAvatar != nil }

    /// 0...1 how strongly the match color tints the badge: grows as they get closer.
    var tintStrength: Double {
        guard pairColors != nil else { return 0 }
        return together ? 1 : max(0, min(1, closeness))
    }

    /// My avatar keeps its own color; proximity tints the badge around it instead.
    var avatarColor: Color { avatar.color }

    /// The two colors the badge blends as a match gets closer: mine and theirs
    /// (or the shared match color when we don't know theirs). Nil when idle.
    var pairColors: (mine: Color, theirs: Color)? {
        guard mode != .idle, let theirs = peerAvatar?.color ?? matchColor else { return nil }
        return (avatar.color, theirs)
    }
```

---

## 2. Flowing aurora background

There are no blurred blobs and no blur filter: the "aurora" is a 4 × 4 `MeshGradient` (16 control points, `smoothsColors: true`) whose interior points drift on slow sine paths and whose vertex colors slowly bleed toward a neighbor in the palette. Over it: a white wash at 0.14 opacity and a film grain at 0.07 opacity in multiply blend. It ignores safe areas, is hidden from accessibility, and starts and stops the motion service on appear and disappear.

* Clock: `TimelineView(.animation(minimumInterval: 1/30, paused: reduceMotion))`. With Reduce Motion it is a still frame.
* `flow` parameter (0 still, 1 normal): 1 on the badge, 0.8 behind the avatar preview, 0.6 on Profile, 0.4 on People detail and the empty People pane.
* Points: grid `(col/3, row/3)`. Interior x (columns 1 and 2) adds `0.11 sin(t × 0.06 flow × (1 + 0.07 seed) + 1.7 seed) + tiltX × 0.08`; interior y (rows 1 and 2) adds `0.11 cos(t × 0.06 flow × (1.1 + 0.05 seed) + 2.3 seed) + tiltY × 0.06`, with `seed = row × 4 + col`. Edge points stay on their edge so the mesh never tears. Clamped to 0...1.
* Colors: vertex i mixes `palette[i]` toward `palette[(i + 5) % 16]` by `0.6 × (0.5 + 0.5 sin(t × 0.035 flow + 0.9 i))`.
* Grain: a `Canvas` of 1 × 1 pt black dots, count `width × height / 14`, alpha 0.25 to 1, seeded with 42, rasterized with `drawingGroup()`.

Palette (row major, 16 vertices):

| Row | Colors |
|---|---|
| 0 | `#9CD9FF` `#A5C3FB` `#EB8FFF` `#FAB2F7` |
| 1 | `#FFEA82` `#F8CD4C` `#FAA752` `#FA9E96` |
| 2 | `#FF6C6E` `#F7A8AB` `#CAFFCC` `#87D9FB` |
| 3 | `#F8B2AE` `#FFEA82` `#A5C3FB` `#EB8FFF` |

**Verbatim** (`DesignSystem/Background/FlowingBackground.swift`, complete):

```swift
// DesignSystem/Background/FlowingBackground.swift lines 1 to 100
import SwiftUI

/// The designer's soft multicolor background, made alive: a mesh gradient whose
/// points drift like slow water and whose colors slowly bleed into their
/// neighbors. Tilting the phone pushes the flow a little.
struct FlowingBackground: View {
    /// 0 = still, 1 = normal flow. Lower it behind dense content.
    var flow: Double = 1
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(MotionService.self) private var motion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            MeshGradient(
                width: 4,
                height: 4,
                points: points(t),
                colors: colors(t),
                smoothsColors: true
            )
        }
        .overlay(Color.white.opacity(0.14)) // the designer's light wash
        .overlay(GrainOverlay().opacity(0.07).blendMode(.multiply))
        .ignoresSafeArea()
        .onAppear { motion.start() }
        .onDisappear { motion.stop() }
        .accessibilityHidden(true)
    }

    /// Interior points wander on slow, out of phase sine paths; edges slide
    /// along their side so the mesh never tears.
    private func points(_ t: Double) -> [SIMD2<Float>] {
        let speed = 0.06 * flow
        let tiltX = motion.tiltX * 0.08
        let tiltY = motion.tiltY * 0.06
        var out: [SIMD2<Float>] = []
        for row in 0..<4 {
            for col in 0..<4 {
                var x = Double(col) / 3
                var y = Double(row) / 3
                let seed = Double(row * 4 + col)
                let interiorX = col != 0 && col != 3
                let interiorY = row != 0 && row != 3
                if interiorX {
                    x += 0.11 * sin(t * speed * (1 + seed * 0.07) + seed * 1.7) + tiltX
                }
                if interiorY {
                    y += 0.11 * cos(t * speed * (1.1 + seed * 0.05) + seed * 2.3) + tiltY
                }
                out.append(SIMD2(Float(min(1, max(0, x))), Float(min(1, max(0, y)))))
            }
        }
        return out
    }

    /// Each vertex color drifts toward the next one in the palette and back.
    private func colors(_ t: Double) -> [Color] {
        let palette = theme.backgroundPalette
        return palette.indices.map { i in
            let next = palette[(i + 5) % palette.count]
            let amount = 0.5 + 0.5 * sin(t * 0.035 * flow + Double(i) * 0.9)
            return palette[i].mix(with: next, by: amount * 0.6)
        }
    }
}

/// Fine film grain like the designer's texture, drawn once and tiled.
private struct GrainOverlay: View {
    var body: some View {
        Canvas { context, size in
            var rng = SeededRandom(seed: 42)
            let count = Int(size.width * size.height / 14)
            for _ in 0..<count {
                let x = CGFloat(rng.next()) * size.width
                let y = CGFloat(rng.next()) * size.height
                let a = 0.25 + 0.75 * rng.next()
                context.fill(Path(CGRect(x: x, y: y, width: 1, height: 1)), with: .color(.black.opacity(a)))
            }
        }
        .drawingGroup()
        .allowsHitTesting(false)
    }
}

/// Small deterministic random generator (xorshift) for textures and avatars.
struct SeededRandom {
    private var state: UInt64

    init(seed: UInt64) { state = seed &* 0x9E37_79B9_7F4A_7C15 | 1 }

    /// 0..<1
    mutating func next() -> Double {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return Double(state % 1_000_000) / 1_000_000
    }
}
```

---

## 3. Badge

### 3.1 Layers (PlayfulBadgeStyle)

The badge is drawn by a swappable `BadgeStyle` that receives a `BadgeConfiguration` (pure data: name, company, layout, photo, avatar, seed, keywords, mode, closeness, match color, peer avatar, together, meetCount, look, presentation worn or window, orientation). Back to front:

1. `FlowingBackground()`
2. `PairWash` (two color current, section 3.5)
3. `MatchGlow` (inner glow of the match color)
4. Content: identity card plus keywords card.

Scale: `scale = width / 402` in portrait (the designer's 402 pt frame) or `width / 874` in landscape. Outer padding `16 × scale` when worn, `14 × scale` in the tab window. Cards use `ConcentricRectangle(corners: .concentric(minimum: .fixed(12 × scale)), isUniform: true)` so they round concentrically with the phone's screen corners when worn, or with the preview frame (set via `.containerShape`) in the tab.

* Portrait: `VStack(spacing: 14 × scale)`: IdentityCard (nameSize `96 × scale`, avatarSpace `120 × scale`) at `height × 0.54`, then KeywordsCard (font `42 × scale`).
* Landscape: `HStack(spacing: 14 × scale)`: IdentityCard (nameSize `92 × scale`, avatarSpace `100 × scale`) at `width × 0.54`, then KeywordsCard (font `40 × scale`).
* Empty keywords show the placeholder "Tell your agent what you're into" at 0.6 of the font size.

**Verbatim** (`DesignSystem/Badge/PlayfulBadgeStyle.swift`):

```swift
// DesignSystem/Badge/PlayfulBadgeStyle.swift lines 13 to 134
private struct PlayfulBadge: View {
    let c: BadgeConfiguration
    @Environment(\.theme) private var theme

    var body: some View {
        GeometryReader { geo in
            let horizontal = c.orientation == .horizontal
            // 1 = the designer's 402 pt portrait frame (or 874 pt landscape)
            let scale = horizontal ? geo.size.width / 874 : geo.size.width / 402
            let worn = c.presentation == .worn
            let pad = (worn ? 16 : 14) * scale
            // Cards round concentrically with what holds them: the phone's own
            // screen corners when worn, the preview frame's corners in the tab
            // (BadgeTabView sets that as the container shape). So inner radius =
            // outer radius minus the gap, at any size.
            let shape = AnyShape(ConcentricRectangle(corners: .concentric(minimum: .fixed(12 * scale)), isUniform: true))

            ZStack {
                FlowingBackground()
                PairWash(colors: c.pairColors, strength: c.tintStrength)
                MatchGlow(color: c.matchColor, intensity: c.tintStrength)

                if horizontal {
                    HStack(spacing: 14 * scale) {
                        IdentityCard(c: c, scale: scale, nameSize: 92 * scale, shape: shape, avatarSpace: 100 * scale)
                            .frame(width: geo.size.width * 0.54)
                        keywords(scale: scale, size: 40 * scale, shape: shape)
                    }
                    .padding(pad)
                } else {
                    VStack(spacing: 14 * scale) {
                        IdentityCard(c: c, scale: scale, nameSize: 96 * scale, shape: shape, avatarSpace: 120 * scale)
                            .frame(height: geo.size.height * 0.54)
                        keywords(scale: scale, size: 42 * scale, shape: shape)
                    }
                    .padding(pad)
                }
            }
        }
    }

    private func keywords(scale: CGFloat, size: CGFloat, shape: AnyShape) -> some View {
        KeywordsCard(
            keywords: c.keywords.isEmpty ? ["Tell your agent what you're into"] : c.keywords,
            matched: c.mode != .idle,
            tint: c.matchColor,
            scale: scale,
            fontSize: c.keywords.isEmpty ? size * 0.6 : size,
            shape: shape
        )
    }
}

/// Both people's avatar colors flowing over the background as one slow
/// current: bands of my color and theirs drift diagonally across the badge and
/// bleed into each other. Faint when a match is first sensed, strong by 3 m.
private struct PairWash: View {
    var colors: (mine: Color, theirs: Color)?
    var strength: Double
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let range = theme.matchWashOpacity
        let opacity = colors != nil && strength > 0 ? range.lowerBound + (range.upperBound - range.lowerBound) * strength : 0
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || opacity == 0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate * theme.pairWashSpeed
            if let colors {
                MeshGradient(width: 3, height: 3, points: Self.points(t), colors: Self.colors(t, colors),
                             smoothsColors: true)
            }
        }
        .opacity(opacity)
        .animation(.easeInOut(duration: 0.8), value: opacity)
        .allowsHitTesting(false)
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    /// The middle points sway a little so the bands breathe.
    private static func points(_ t: Double) -> [SIMD2<Float>] {
        var out: [SIMD2<Float>] = []
        for row in 0..<3 {
            for col in 0..<3 {
                var x = Double(col) / 2, y = Double(row) / 2
                if col == 1 { x += 0.12 * sin(t * 0.7 + Double(row) * 1.3) }
                if row == 1 { y += 0.12 * cos(t * 0.6 + Double(col) * 1.1) }
                out.append(SIMD2(Float(x), Float(y)))
            }
        }
        return out
    }

    /// One direction for the whole badge: a wave of mine to theirs travelling
    /// from the top left corner to the bottom right.
    private static func colors(_ t: Double, _ c: (mine: Color, theirs: Color)) -> [Color] {
        var out: [Color] = []
        for row in 0..<3 {
            for col in 0..<3 {
                let phase = Double(row + col) * 1.05 - t
                let mix = 0.5 + 0.5 * sin(phase)
                out.append(c.mine.mix(with: c.theirs, by: mix))
            }
        }
        return out
    }
}

/// Soft inner glow in the shared match color, stronger as they get closer.
private struct MatchGlow: View {
    var color: Color?
    var intensity: Double

    var body: some View {
        Rectangle()
            .strokeBorder((color ?? .clear).opacity(0.9 * intensity), lineWidth: 10 + 40 * intensity)
            .blur(radius: 18 + 30 * intensity)
            .allowsHitTesting(false)
            .animation(.easeInOut(duration: 0.8), value: intensity)
            .ignoresSafeArea()
    }
}
```

### 3.2 Identity card

White card (`theme.surface`, tinted by the pair blend). Three layouts:

* `avatar` (default): a room on top (min height `avatarSpace`, grows to fill), name below with padding `18 × scale`. Alone, the avatar stage is `side = min(h / 0.8, w × 0.85)` placed at `x = w − 0.4 side`, `y = min(h − 0.5 side, 0.42 side)`: it peeks from the top right and may be cropped by the card's top edge. Once met, the stage moves to the room center with `side = min(h, 0.85 w)`, animated `spring(response 0.7, damping 0.62)`.
* `photoText`: name at 0.78 of the size (semibold first line, medium second) on the left; photo column `0.42 × cardWidth` on the right, corner `14 × scale`, inset `12 × scale`; the avatar stage (`0.5 × photoWidth`) hangs off the photo's top left corner at offset `(−0.2, −0.06) × photoWidth`. Min height `1.15 × photoWidth`.
* `photo`: full bleed photo with a black gradient from clear at center to 0.55 at bottom, white name with `shadow(black 0.3, radius 6, y 2)`, avatar reach 0.42.
* Company size `26 × scale` max.
* `tintStrength` changes animate `easeInOut(0.8)`.

**Verbatim** (`DesignSystem/Badge/IdentityCard.swift` 43 to 164):

```swift
// DesignSystem/Badge/IdentityCard.swift lines 43 to 164
    private var pad: CGFloat { 18 * scale }

    // MARK: Layouts

    /// The avatar lives in the room above the name and never reaches into it,
    /// so a long name can't end up under the avatar.
    private var avatarCard: some View {
        nameUnderAvatar(ink: theme.strongInk, avatarReach: 0.85)
            .background(surface)
    }

    /// The card takes on a little of both people's colors as they get closer.
    private var surface: Color {
        guard let pair = c.pairColors, c.tintStrength > 0 else { return theme.surface }
        let blend = pair.mine.mix(with: pair.theirs, by: 0.5)
        return theme.surface.mix(with: blend, by: theme.matchCardTint * c.tintStrength)
    }

    private var photoBeside: some View {
        let photoWidth = (cardWidth > 0 ? cardWidth : 360 * scale) * 0.42
        return HStack(spacing: 0) {
            name(size: nameSize * 0.78, ink: theme.strongInk, weight: .semibold, lastWeight: .medium)
                .padding(.horizontal, pad)
                .padding(.bottom, pad)
                .padding(.top, photoWidth * 0.5)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            Color.clear
                .frame(width: photoWidth)
                .frame(maxHeight: .infinity)
                .overlay { photo }
                .clipShape(RoundedRectangle(cornerRadius: 14 * scale))
                // The avatar hangs off the photo's top corner, away from the name
                .overlay(alignment: .topLeading) {
                    stage
                        .frame(width: photoWidth * 0.5, height: photoWidth * 0.5)
                        .offset(x: -photoWidth * 0.2, y: -photoWidth * 0.06)
                }
                .padding(12 * scale)
        }
        .frame(minHeight: photoWidth * 1.15)
        .background(surface)
    }

    private var fullPhoto: some View {
        nameUnderAvatar(ink: .white, avatarReach: 0.42)
            .shadow(color: .black.opacity(0.3), radius: 6, y: 2)
            .background {
                ZStack {
                    Color.clear.overlay { photo }.clipped()
                    LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
                }
            }
    }

    /// The avatar's room on top, the name below it.
    private func nameUnderAvatar(ink: Color, avatarReach: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear
                .frame(maxWidth: .infinity, minHeight: avatarSpace, maxHeight: .infinity)
                .overlay { GeometryReader { geo in placedStage(in: geo.size, reach: avatarReach) } }
            name(size: nameSize, ink: ink)
                .padding(.horizontal, pad)
                .padding(.bottom, pad)
        }
    }

    /// Alone, the avatar peeks from the top right, cropped by the card's top
    /// edge when the name leaves little room. Once we meet, the stage moves to
    /// the middle of the room so both avatars land inside the card.
    private func placedStage(in room: CGSize, reach: CGFloat) -> some View {
        let w = room.width, h = room.height
        let side = c.hasMet ? min(h, w * 0.85) : min(h / 0.8, w * reach)
        let x = c.hasMet ? w / 2 : w - side * 0.4
        let y = c.hasMet ? h / 2 : min(h - side * 0.5, side * 0.42)
        return stage
            .frame(width: side, height: side)
            .position(x: x, y: y)
            .animation(.spring(response: 0.7, dampingFraction: 0.62), value: c.hasMet)
    }

    // MARK: Parts

    private var stage: some View {
        AvatarStage(
            avatar: c.avatar,
            color: c.avatarColor,
            expression: c.expression,
            look: c.look,
            followsTilt: c.followsTilt,
            seed: c.seed,
            peer: c.peerAvatar,
            peerSeed: c.peerSeed,
            hasMet: c.hasMet,
            peerSide: (c.look?.x ?? 1) < 0 ? -1 : 1,
            meetCount: c.meetCount,
            rippleColor: c.pairColors.map { $0.mine.mix(with: $0.theirs, by: 0.5) } ?? c.avatarColor
        )
        // The wearer's own idle avatar feels the phone move (walking, shakes, stillness)
        .avatarSensesMotion(c.followsTilt)
    }

    private var photo: some View {
        AsyncImage(url: c.photoURL) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            c.avatar.color.opacity(0.35)
        }
    }

    /// First name biggest, the rest of the name a step down, then the company.
    private func name(size: CGFloat, ink: Color, weight: Font.Weight? = nil, lastWeight: Font.Weight? = nil) -> some View {
        NameLockup(
            name: c.name,
            company: c.company,
            size: size,
            companySize: 26 * scale,
            ink: ink,
            companyInk: ink.opacity(0.7),
            weight: weight,
            lastWeight: lastWeight
        )
    }
```

### 3.3 Name lockup math

* The name splits at the first whitespace: first word on line one, the rest on line two.
* Line one: `size × s` in `nameWeight` (bold); line two: `size × s × 0.64` in `nameLastWeight` (semibold), with top padding `size × s × −0.12` (pulled up under line one).
* Tracking: `fontSize × −0.025` on each line.
* `s` is chosen by `ViewThatFits(in: .horizontal)` from the candidates 1.0, 0.95, 0.90 ... 0.30 (step 0.05, 15 candidates); both lines shrink together so the hierarchy is kept. Every candidate is `fixedSize` horizontally except the last (0.30), which may also apply `minimumScaleFactor(0.5)`.
* Company: `min(companySize, size × 0.34)` in medium, ink at 0.7 opacity, one line, `minimumScaleFactor(0.6)`, top padding `0.3 ×` its size. Note the company uses the unfitted `size`, not the fitted one.
* Fonts are `brandFixed` (General Sans at a fixed size, not Dynamic Type scaled).

**Verbatim** (`DesignSystem/Badge/NameLockup.swift`):

```swift
// DesignSystem/Badge/NameLockup.swift lines 8 to 85
struct NameLockup: View {
    var name: String
    var company: String?
    /// First name size before fitting.
    var size: CGFloat
    /// Largest company size.
    var companySize: CGFloat
    var ink: Color
    var companyInk: Color
    /// Lighter weights for the photo beside layout.
    var weight: Font.Weight?
    var lastWeight: Font.Weight?

    @Environment(\.theme) private var theme

    /// Scales tried in order, largest first.
    private static let scales: [CGFloat] = Array(stride(from: 1.0, through: 0.3, by: -0.05))

    var body: some View {
        let parts = Self.split(name)
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                ForEach(Self.scales, id: \.self) { scale in
                    lines(parts, scale: scale, last: scale == Self.scales.last)
                }
            }
            if let company {
                let size = min(companySize, size * theme.nameCompanyRatio)
                Text(company)
                    .font(.brandFixed(size, .medium))
                    .foregroundStyle(companyInk)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.top, size * 0.3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var firstWeight: Font.Weight { weight ?? theme.nameWeight }
    private var secondWeight: Font.Weight { lastWeight ?? theme.nameLastWeight }

    private func lines(_ parts: (first: String, last: String?), scale: CGFloat, last isFallback: Bool) -> some View {
        let first = size * scale
        return VStack(alignment: .leading, spacing: 0) {
            line(parts.first, size: first, weight: firstWeight, fallback: isFallback)
            if let last = parts.last {
                line(last, size: first * theme.nameLastRatio, weight: secondWeight, fallback: isFallback)
                    .padding(.top, first * theme.nameLineGap)
            }
        }
    }

    /// Each candidate keeps its natural width so ViewThatFits can judge it;
    /// only the smallest one may squeeze further.
    @ViewBuilder
    private func line(_ text: String, size: CGFloat, weight: Font.Weight, fallback: Bool) -> some View {
        let t = Text(text)
            .font(.brandFixed(size, weight))
            .tracking(size * theme.nameTracking)
            .foregroundStyle(ink)
            .lineLimit(1)
        if fallback {
            t.minimumScaleFactor(0.5)
        } else {
            t.fixedSize(horizontal: true, vertical: false)
        }
    }

    /// First word on top, everything after it on the second line.
    static func split(_ name: String) -> (first: String, last: String?) {
        let words = name.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let first = words.first else { return (name, nil) }
        let rest = words.dropFirst().joined(separator: " ")
        return (first, rest.isEmpty ? nil : rest)
    }
}
```

### 3.4 Keywords card and the staggered flip

* Header: "Ask me about" (idle) or "Talk to me about" (matched), `brandFixed(17 × scale, .medium)`, ink at 0.7.
* Rows: 1 to 3 phrases, `brandFixed(fontSize, .semibold)`, black, up to 2 lines, `minimumScaleFactor(0.55)`, row spacing `6 × scale`, separated by 2 × scale rules of ink at 0.15. Padding `22 × scale`.
* Background: yellow `#FFEA82` when idle; the match color when matched (`easeInOut(0.6)` on the change).
* Keyword source: while matched, the server's keywords (first 3), else the front tag; idle shows my first 3 tags (or hobbies if no tags).
* **Flip**: each row is a slot keyed by index; the text inside has `.id(keyword)` and `.transition(.flip)`. The flip transition rotates around the x axis with perspective 0.6, inserting from −90° and removing to +90°, and hides the face past 60°.
* **Stagger**: when the list changes, rows are swapped one at a time top to bottom, each with `spring(duration 0.9, bounce 0.22)`, then a 420 ms wait before the next changed row (unchanged rows are skipped without waiting). Extra old rows are removed in one final animated step. Reduce Motion swaps instantly.

**Verbatim** (`DesignSystem/Badge/FlipTransition.swift` and `KeywordsCard.swift` 14 to 88):

```swift
// DesignSystem/Badge/FlipTransition.swift lines 1 to 21
import SwiftUI

extension AnyTransition {
    /// Rotate in from below, out to the top, around the horizontal axis.
    static var flip: AnyTransition {
        .asymmetric(
            insertion: .modifier(active: FlipModifier(angle: -90), identity: FlipModifier(angle: 0)),
            removal: .modifier(active: FlipModifier(angle: 90), identity: FlipModifier(angle: 0))
        )
    }
}

private struct FlipModifier: ViewModifier {
    var angle: Double

    func body(content: Content) -> some View {
        content
            .rotation3DEffect(.degrees(angle), axis: (x: 1, y: 0, z: 0), anchor: .center, perspective: 0.6)
            .opacity(abs(angle) > 60 ? 0 : 1)
    }
}
```

```swift
// DesignSystem/Badge/KeywordsCard.swift lines 14 to 88
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// What is on screen. Lags `keywords` while a reshuffle plays out row by row.
    @State private var shown: [String]? = nil
    @State private var reshuffle: Task<Void, Never>?

    /// Each row flips over on its own, one after another, so the reranking reads.
    static let rowDelay: Duration = .milliseconds(420)
    static let flipAnimation = Animation.spring(duration: 0.9, bounce: 0.22)

    var body: some View {
        VStack(alignment: .leading, spacing: 12 * scale) {
            Text(matched ? "Talk to me about" : "Ask me about")
                .font(.brandFixed(17 * scale, .medium))
                .foregroundStyle(theme.ink.opacity(0.7))

            VStack(alignment: .leading, spacing: 6 * scale) {
                // Rows are slots; a slot flips over when its word changes
                ForEach(Array((shown ?? keywords).enumerated()), id: \.offset) { index, keyword in
                    if index > 0 {
                        Rectangle().fill(theme.ink.opacity(0.15)).frame(height: 2 * scale)
                    }
                    // The old and new word share the row while it flips over
                    ZStack(alignment: .leading) {
                        Text(keyword)
                            .font(.brandFixed(fontSize, .semibold))
                            .foregroundStyle(theme.strongInk)
                            .lineLimit(2)
                            .minimumScaleFactor(0.55)
                            .fixedSize(horizontal: false, vertical: true)
                            .id(keyword)
                            .transition(.flip)
                    }
                }
            }
        }
        .padding(22 * scale)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(matched ? (tint ?? theme.yellow) : theme.yellow, in: shape)
        .animation(.easeInOut(duration: 0.6), value: matched)
        .accessibilityElement(children: .combine)
        .onChange(of: keywords) { old, new in play(from: shown ?? old, to: new) }
        .onDisappear { reshuffle?.cancel() }
    }

    /// Swap the rows one at a time, top to bottom.
    private func play(from old: [String], to new: [String]) {
        reshuffle?.cancel()
        if reduceMotion {
            shown = new
            return
        }
        shown = old
        reshuffle = Task { @MainActor in
            var current = old
            for i in 0..<max(old.count, new.count) {
                if i < new.count {
                    if i < current.count {
                        guard current[i] != new[i] else { continue }
                        current[i] = new[i]
                    } else {
                        current.append(new[i])
                    }
                } else {
                    current.removeLast(current.count - new.count)
                    withAnimation(Self.flipAnimation) { shown = current }
                    break
                }
                withAnimation(Self.flipAnimation) { shown = current }
                try? await Task.sleep(for: Self.rowDelay)
                if Task.isCancelled { return }
            }
            shown = nil // caught up: follow `keywords` directly again
        }
    }
```

### 3.5 Match wash, glow and card tint by distance

Closeness comes from this phone's own UWB reading when it has one (match or connected mode): `closeness = clamp((8 − meters) / (8 − 2), 0, 1)`, so 0 at 8 m and 1 at 2 m. Otherwise the server's closeness is used. `tintStrength = together ? 1 : closeness`.

* PairWash opacity = `0.12 + (0.72 − 0.12) × strength` when there are pair colors and strength > 0, else 0. Animated `easeInOut(0.8)`. Its mesh is 3 × 3; middle column x sways `0.12 sin(0.7t + 1.3 row)`, middle row y sways `0.12 cos(0.6t + 1.1 col)`; vertex color `mine.mix(with: theirs, by: 0.5 + 0.5 sin(1.05 (row + col) − t))` with `t = seconds × 0.35`: one wave travelling from top left to bottom right. Paused with Reduce Motion or at opacity 0.
* MatchGlow: a full screen `Rectangle().strokeBorder(matchColor.opacity(0.9 i), lineWidth: 10 + 40 i).blur(radius: 18 + 30 i)`, i = tintStrength, `easeInOut(0.8)`.
* Card tint: identity card surface mixes toward the pair blend by `0.22 × strength`.
* Expression switches from curious to excited above closeness 0.6 (closer than 4.4 m).

| Distance (local UWB) | closeness | wash opacity | glow line width | glow blur | card tint |
|---|---|---|---|---|---|
| ≥ 8 m | 0 | 0 (off) | 10 (opacity 0) | 18 | 0 |
| 7 m | 0.167 | 0.22 | 16.7 | 23 | 0.037 |
| 6 m | 0.333 | 0.32 | 23.3 | 28 | 0.073 |
| 5 m | 0.5 | 0.42 | 30 | 33 | 0.11 |
| 4 m | 0.667 | 0.52 | 36.7 | 38 | 0.147 |
| 3 m | 0.833 | 0.62 | 43.3 | 43 | 0.183 |
| ≤ 2 m or together | 1 | 0.72 | 50 | 48 | 0.22 |

**Note (ambiguous comments)**: the Theme comment says the wash opacity ramps "from 10 m to 3 m" and the PairWash comment says "strong by 3 m", but the code ramps on closeness, which is 0 at 8 m and 1 at 2 m. The table follows the code. Settings text also says "A match starts to show within 8 m and you are together within 2 m".

### 3.6 The meet moment, in order

Trigger (`BadgeStore.nearbyDistance`, called with each smoothed UWB reading): only while the badge is **worn**, the reading is from the current match (`state.peerId`), the mode is not idle, and the reading is "near" (≤ 2.0 m). Hysteresis: ≤ 2.0 m is near, > 3.0 m is apart, between keeps the last side. Confirmation: 3 readings in a row on the same side spanning at least 0.4 s. Once per meeting: meeting the same person again counts only after being apart at least 20 s. Server state `talking` while worn also counts as meeting. UWB distance smoothing on the phone: if the jump exceeds 1 m, `0.3 old + 0.7 new`, else `0.6 old + 0.4 new`.

Timeline (t = 0 when `meetCount` increments):

| t (s) | Visual | Sound | Haptic |
|---|---|---|---|
| 0 | `together` becomes true: `hasMet` lays out both avatars (spring 0.7 / 0.62). Mine shrinks to 0.72 of the stage and moves `−side × 0.2 × size` sideways and `0.12 size` down; the stage centers in the card's room. Theirs (0.66 size, at `+side × 0.28, +0.14`) enters with `jumpIn`: from 1.2 size off to its side along a parabola 0.7 size high with a quarter turn spin. Wash, glow and card tint go to full (easeInOut 0.8). Mine starts `MeetLeap`: crouch to squash 0.8 over 0.1 s. | | |
| 0.1 | Mine leaps: lift to −0.3 size by 0.32, travel toward theirs to 0.16 size by 0.52, stretch to squash 1.12 by 0.3 | | |
| 0.22 | Theirs starts its leap (same keyframes, 0.12 s delay, toward me) | | |
| 0.5 | Mine back on the ground (lift 0 at 0.52) | `met` "stone in a lake": low D2 thump falling from A2, D3 body, a swelling noise wash with a soft fifth, three ripple droplets at +0.2, +0.42, +0.7 s (A3, F♯3, D3), 2.1 s long | `settle()`: one heavy transient (intensity 1, sharpness 0.08), then a 1.1 s continuous rumble (0.55, 0.02) from 0.53 fading 1, 0.5, 0.2, 0 at 0, 0.25, 0.6, 1.1 s, plus faint transients at 0.82 (0.45) and 1.1 (0.35) |
| 0.5 | The approach heartbeat stops (BadgeCues.together) | | |
| 0.59 | Mine lands heavy: squash 0.74, then `.bouncy` spring to 1 over 0.6 s; travel springs back to 0 over 0.8 s `.smooth` | | |
| 0.6 | Ripples: three ellipse rings in the pair blend color under the avatars (frame `1.6 size × 0.5 size`, offset `0.4 size` down). Opacity jumps to 0.8 by 0.65 then fades over 1.65 s; progress 0 to 1 from 0.6 to 2.3 s; ring i uses `p = clamp(1.35 progress − 0.18 i)`, scale `0.25 + 0.9 p`, line width `2 + 5(1 − p)`, opacity `rippleOpacity × (1 − p)` (zero until p > 0) | | |
| 0.71 | Theirs lands with its squash | | |
| 1.8 | Earliest the microphone may start recording (it waits `1.8 − elapsed` so the meet sound rings out on the speaker) | | |
| 2.3 | Ripples gone | | |

Rules: the met sound and haptic only play while the badge is shown (worn or the Badge tab preview visible) and the app is active, throttled to once per 3 s. If `talking` starts within 30 s of a meet, the separate `talkStart` cue is skipped. With Reduce Motion the leap is skipped (trigger forced to 0) but the layout change and ripples still play. The `MeetLeap` keyframes are in the AvatarStage code in 1.9.

**Verbatim** (`Core/Stores/BadgeStore.swift` constants and meet):

```swift
// Core/Stores/BadgeStore.swift lines 59 to 75
    /// Same as TALK_DISTANCE_M in backend/convex/lib/constants.ts. Checked on
    /// every local UWB reading, so the moment fires without waiting for the server.
    static let meetDistance = 2.0
    /// Further than this, we have parted (same as TALK_EXIT_DISTANCE_M).
    static let apartDistance = 3.0
    /// UWB readings jump around: this many readings in a row, over at least
    /// this long, confirm we came together (or parted). About half a second.
    static let confirmReadings = 3
    static let confirmTime: TimeInterval = 0.4
    /// Taking the badge off stops the recording after this long (an accidental
    /// swipe out and straight back in keeps it going).
    static let takeOffGrace: Duration = .seconds(2)
    /// Apart at least this long before meeting the same person counts again.
    static let meetAgainAfter: TimeInterval = 20
    /// Out of the talking state this long before the conversation really ends.
    static let leaveGrace: Duration = .seconds(6)
```

```swift
// Core/Stores/BadgeStore.swift lines 127 to 181
    /// This phone's smoothed UWB distance to a peer (NearbyService, a few times a second).
    func nearbyDistance(peerId: String, meters: Double) {
        let now = Date()
        // Which side of the line is this reading on? Between the two distances
        // keeps whatever we were (no flicker right at the threshold).
        let near: Bool? = meters <= Self.meetDistance ? true : (meters > Self.apartDistance ? false : nil)
        if let near {
            if let s = streak, s.peerId == peerId, s.near == near {
                streak = (peerId, near, s.count + 1, s.since)
            } else {
                streak = (peerId, near, 1, now)
            }
        }
        let confirmed = streak.map {
            $0.peerId == peerId && $0.count >= Self.confirmReadings && now.timeIntervalSince($0.since) >= Self.confirmTime
        } ?? false

        if peerId == togetherWith, near == false, confirmed {
            togetherWith = nil
            cues.together = false
        }
        if peerId == togetherWith { lastTogether = now }
        guard isWorn, peerId == state.peerId, state.mode != .idle, near == true, confirmed else { return }
        meet(peerId)
    }

    /// The "we finally met" moment, once per meeting: the first time we come
    /// within talking distance, or again after being apart for a while.
    private func meet(_ peerId: String) {
        let now = Date()
        defer { lastTogether = now }
        if peerId == metPeerId, now.timeIntervalSince(lastTogether) < Self.meetAgainAfter {
            togetherWith = peerId // still together (or back after a blip)
            cues.together = true
            return
        }
        metPeerId = peerId
        togetherWith = peerId
        lastMeetAt = now
        meetCount += 1
        // Let the avatars leap first; the stone lands with them.
        Task {
            try? await Task.sleep(for: .seconds(0.5))
            self.cues.met()
        }
        if let userId {
            Task { [backend] in
                do {
                    try await backend.markMet(userId: userId, otherId: peerId)
                } catch {
                    print("mark met failed:", error)
                }
            }
        }
    }
```

### 3.7 Approach heartbeat and state cues

`BadgeCues` plays only while the badge is shown and the app is active:

* Mode becomes `match` (or the match person changes): `matchAppears` chime (throttle 3 s).
* While in `match` and not together: a heartbeat loop. First beat after 1.2 s if the match just appeared (lets the chime ring), else 0.4 s. Interval `2.5 − 1.9 × closeness^0.85` seconds (2.5 s far, 0.6 s at talking distance). Each beat is `approachTick(closeness, prominent: isWorn)`.
* Mode becomes `talking`: `talkStart`, unless a meet happened in the last 30 s.
* Mode becomes `connected`: `saved` celebration.

**Verbatim** (`Core/Feedback/BadgeCues.swift` 41 to 102):

```swift
// Core/Feedback/BadgeCues.swift lines 41 to 102
    func update(_ state: BadgeState) {
        let old = mode, oldPeer = peerId
        mode = state.mode
        peerId = state.peerId
        closeness = max(0, min(1, state.closeness))

        if isShown {
            switch state.mode {
            case .match where old != .match || oldPeer != state.peerId:
                Feedback.shared.play(.matchAppears)
            case .talking where old != .talking:
                // Right after the meet moment the settling sound says it already
                if lastMetAt.map({ Date().timeIntervalSince($0) > 30 }) ?? true {
                    Feedback.shared.play(.talkStart)
                }
            case .connected where old != .connected:
                Feedback.shared.play(.saved)
            default:
                break
            }
        }
        refresh(justAppeared: old != .match)
    }

    /// The "we finally met" moment (BadgeStore decides when, once per meeting).
    func met() {
        lastMetAt = Date()
        together = true
        if isShown { Feedback.shared.play(.met) }
    }

    /// Signed out.
    func reset() {
        mode = .idle
        peerId = nil
        closeness = 0
        lastMetAt = nil
        together = false
        refresh()
    }

    /// Run the heartbeat only while a match approaches and the badge is shown.
    private func refresh(justAppeared: Bool = false) {
        let shouldBeat = mode == .match && isShown && !together
        if !shouldBeat {
            heartbeat?.cancel()
            heartbeat = nil
            return
        }
        guard heartbeat == nil else { return }
        heartbeat = Task { [weak self] in
            // Let the match chime ring out before the first beat
            try? await Task.sleep(for: .seconds(justAppeared ? 1.2 : 0.4))
            while !Task.isCancelled, let self {
                let c = self.closeness
                Feedback.shared.play(.approachTick(closeness: c, prominent: self.isWorn))
                // 2.5 s far away down to 0.6 s at talking distance
                let interval = 2.5 - 1.9 * pow(c, 0.85)
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
```

### 3.8 Badge tab window and the recording pill

* The preview has the exact aspect of the full screen (including safe areas), fits in `(width − 64) × (height − 170)`, corner radius `max(14, 55 × scale)` where scale = preview width / screen width, white 6 pt border, `shadow(black 0.14, radius 20, y 10)`, and sets itself as the container shape so badge cards round concentrically.
* Landscape orientation when aspect > 1.
* Recording pill: overlays the top of the badge (10 pt down) while recording: white at 0.92 capsule, padding 10 × 5, theme shadow, five capsule bars 3 pt wide, max 14 pt tall, spacing 2, weights `[0.55, 0.85, 1, 0.75, 0.5]`, fill `0.16 + 0.84 × min(1, level × weight × wobble × 1.25)` with `wobble = 0.75 + 0.25 sin(t(9 + 2.3i) + 1.7i)` (1 with Reduce Motion), color `#FF3B30` at `0.55 + 0.45 level`, redrawn at 20 fps (paused when level < 0.02), then `mm:ss` elapsed in caption semibold monospaced digits. Mic level smoothing at 20 Hz: `k = 0.55` rising, `0.18` falling. Level from RMS mapped `(dB + 55) / 45` clamped.

**Verbatim** (`Features/Badge/BadgeTabView.swift` 12 to 122 and `RecordingIndicator.swift`):

```swift
// Features/Badge/BadgeTabView.swift lines 12 to 122
    private static let pinchToWear: CGFloat = 1.15
    /// Approximate display corner radius of current iPhones (points).
    private static let screenCornerRadius: CGFloat = 55
    private static let liftToWear: CGFloat = -70

    var body: some View {
        @Bindable var badge = env.badge
        GeometryReader { geo in
            // A true preview: the same shape as this screen when the badge goes
            // full screen (tall on a phone, wide on an open iPhone Duo or iPad),
            // the same layout, and corners scaled from the screen's own.
            let full = CGSize(
                width: geo.size.width + geo.safeAreaInsets.leading + geo.safeAreaInsets.trailing,
                height: geo.size.height + geo.safeAreaInsets.top + geo.safeAreaInsets.bottom
            )
            let aspect = max(0.3, full.width / max(full.height, 1))
            let box = CGSize(width: geo.size.width - 64, height: geo.size.height - 170)
            let width = max(80, min(box.width, box.height * aspect))
            let height = width / aspect
            let scale = width / max(full.width, 1)
            let radius = max(14, Self.screenCornerRadius * scale)
            let orientation: BadgeConfiguration.Orientation = aspect > 1 ? .horizontal : .vertical
            VStack(spacing: 18) {
                HStack {
                    Text("Badge").font(theme.largeTitle).foregroundStyle(theme.strongInk)
                    Spacer()
                    if env.usingMock {
                        Text("Demo data").font(theme.caption).foregroundStyle(theme.inkSecondary)
                    }
                    IconButton(systemImage: "arrow.up.left.and.arrow.down.right", label: "Wear badge") {
                        env.badge.wear()
                    }
                }

                BadgeView(presentation: .window, orientation: orientation)
                    .frame(width: width, height: height)
                    // Inner cards round concentrically with this frame
                    .containerShape(RoundedRectangle(cornerRadius: radius))
                    .clipShape(RoundedRectangle(cornerRadius: radius))
                    .recordingIndicator(env.badge.recordingStartedAt)
                    .overlay(RoundedRectangle(cornerRadius: radius).stroke(.white, lineWidth: 6))
                    .shadow(color: .black.opacity(0.14), radius: 20, y: 10)
                    .scaleEffect(min(max(pinch, 0.95), 1.15) * (1 + min(0.12, -lift / 900)))
                    .offset(y: lift * 0.35)
                    .animation(.spring(response: 0.35, dampingFraction: 0.7), value: lift)
                    .matchedTransitionSource(id: "badge", in: namespace)
                    // Two ways in: pinch out, or swipe up. Swipe down in the
                    // worn badge (or pinch in) takes it off again. One combined
                    // gesture (not simultaneous with the children), so dragging
                    // the avatar squishes it instead of wearing the badge.
                    .gesture(
                        MagnifyGesture()
                            .updating($pinch) { value, state, _ in state = value.magnification }
                            .onEnded { value in if value.magnification > Self.pinchToWear { env.badge.wear() } }
                            .simultaneously(with:
                                DragGesture(minimumDistance: 12)
                                    .updating($lift) { value, state, _ in
                                        let dy = value.translation.height
                                        state = dy < 0 ? dy : dy / 6 // resist downward pulls
                                    }
                                    .onEnded { value in
                                        if value.translation.height < Self.liftToWear
                                            || value.predictedEndTranslation.height < -220 {
                                            env.badge.wear()
                                        }
                                    }
                            )
                    )
                    // A tick when letting go would wear it
                    .onChange(of: pinch > Self.pinchToWear || lift < Self.liftToWear) { _, armed in
                        if armed { Feedback.shared.play(.detent) }
                    }
                    .accessibilityAction(named: "Wear badge") { env.badge.wear() }

                Text(statusLine)
                    .font(theme.body)
                    .foregroundStyle(theme.inkSecondary)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)
                    .animation(.easeInOut, value: statusLine)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.background)
        .onAppear { env.badge.isPreviewVisible = true }
        .onDisappear { env.badge.isPreviewVisible = false }
        .fullScreenCover(isPresented: $badge.isWorn) {
            WornBadgeView()
                .navigationTransition(.zoom(sourceID: "badge", in: namespace))
        }
    }

    private var statusLine: String {
        let state = env.badge.state
        let name = state.peerName ?? "Someone"
        switch state.mode {
        case .idle: return "Swipe up or pinch out to wear it. Your badge reacts when someone you should meet comes close."
        case .match where env.badge.togetherWith == state.peerId:
            return "You found \(name)! Say hi."
        case .match: return "\(name) is nearby. Your avatar is taking on your shared color."
        case .talking:
            return env.badge.recordingStartedAt == nil
                ? "You're talking with \(name)."
                : "You're talking with \(name). Recording for your summary."
        case .connected: return "\(name) is in your People. Say hi again!"
        }
    }
```

```swift
// Features/Badge/RecordingIndicator.swift lines 6 to 76
struct RecordingIndicator: View {
    var startedAt: Date
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 7) {
            LevelMeter()
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                Text(Self.elapsed(from: startedAt, to: context.date))
                    .font(theme.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(theme.ink)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(theme.surface.opacity(0.92), in: Capsule())
        .shadow(color: theme.shadowColor, radius: theme.shadowRadius, y: theme.shadowY)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Recording")
        .accessibilityValue(Self.elapsed(from: startedAt, to: Date()))
        .transition(.scale(scale: 0.6).combined(with: .opacity))
    }

    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

/// Bars that rise with the microphone level. Reads the level itself, so only
/// these bars redraw 20 times a second, not the whole badge. Silence keeps them
/// low and still; with Reduce Motion they move together, without the ripple.
private struct LevelMeter: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// How much each bar answers the level: tallest in the middle, like a voice.
    private static let weights: [Double] = [0.55, 0.85, 1, 0.75, 0.5]
    private static let height: CGFloat = 14

    var body: some View {
        let level = env.badge.micLevel
        TimelineView(.animation(minimumInterval: 1.0 / 20, paused: reduceMotion || level < 0.02)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: 2) {
                ForEach(Self.weights.indices, id: \.self) { i in
                    // Each bar flickers a little out of step with the others while someone speaks
                    let wobble = reduceMotion ? 1 : 0.75 + 0.25 * sin(t * (9 + Double(i) * 2.3) + Double(i) * 1.7)
                    let fill = 0.16 + 0.84 * min(1, level * Self.weights[i] * wobble * 1.25)
                    Capsule()
                        .fill(theme.recordingDot.opacity(0.55 + 0.45 * level))
                        .frame(width: 3, height: max(3, Self.height * CGFloat(fill)))
                }
            }
            .frame(height: Self.height)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: level)
    }
}

extension View {
    /// Shows the recording pill at the top of the badge while a conversation is recorded.
    func recordingIndicator(_ startedAt: Date?) -> some View {
        overlay(alignment: .top) {
            if let startedAt {
                RecordingIndicator(startedAt: startedAt).padding(.top, 10)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.7), value: startedAt)
    }
```

---

## 4. Every animation spring and where it is used

| Where | Animation |
|---|---|
| Shape morph (engine) | 0.7 s `easeOutBack`: `1 + 2.4 (x − 1)³ + 1.4 (x − 1)²` |
| Expression change (engine) | exponential approach, rate 8 per s |
| Idle weight in or out (engine) | exponential, rate 3 per s |
| Idle activity cross fade | smoothstep over 0.75 s (cycle), 0.8 s (activity starts), 0.9 s (activity ends), 0 s (first) |
| Finger down on avatar | `.spring(response: 0.18, dampingFraction: 0.55)` |
| Release after tap | `.spring(response: 0.28, dampingFraction: 0.7)` |
| Release after drag | `.spring(response: 0.5, dampingFraction: 0.42 − 0.14 × stretch)` |
| Tap hop | keyframes (1.9): CubicKeyframe, default SpringKeyframe, `.bouncy` |
| Meet leap | keyframes (1.9): CubicKeyframe, `.bouncy` landing, `.smooth` travel back |
| Meet ripples | Linear then Cubic keyframes, 2.3 s total |
| Delight end (happy face off) | default `withAnimation` after 1.4 s |
| Two avatars share the frame (`hasMet`) | `.spring(response: 0.7, dampingFraction: 0.62)` in AvatarStage and IdentityCard |
| Peer avatar entrance | `jumpIn` transition (parabola, quarter spin), driven by the hasMet spring; removal is opacity plus scale 0.6 |
| Identity card tint | `.easeInOut(duration: 0.8)` |
| PairWash opacity, MatchGlow | `.easeInOut(duration: 0.8)` |
| Keywords card background | `.easeInOut(duration: 0.6)` |
| Keyword row flip | `.spring(duration: 0.9, bounce: 0.22)`, 420 ms stagger |
| Interest chips appear or reorder | `.spring(duration: 0.5, bounce: 0.3)`, transition scale plus opacity |
| Button press | `pressSpring = .spring(response: 0.22, dampingFraction: 0.6)`; scale 0.97 primary, 0.96 secondary, 0.92 icon and card buttons |
| Badge preview lift with finger | `.spring(response: 0.35, dampingFraction: 0.7)`; scale `clamp(pinch, 0.95, 1.15) × (1 + min(0.12, −lift / 900))`, offset `lift × 0.35` |
| Wear badge | `fullScreenCover` with `.navigationTransition(.zoom(sourceID: "badge"))` from the preview |
| Recording pill in or out | `.spring(response: 0.4, dampingFraction: 0.7)`, transition scale 0.6 plus opacity; bars `.easeOut(duration: 0.08)` |
| Status line under the preview | `.easeInOut` (default duration) with `.contentTransition(.opacity)` |
| Onboarding step change | `.spring(response: 0.5, dampingFraction: 0.86)`; avatar step leaves to the leading edge, setup step enters from trailing |
| Onboarding progress dots | `.spring(response: 0.4, dampingFraction: 0.75)` |
| Onboarding shape pick | `.spring(response: 0.35, dampingFraction: 0.7)` |
| Setup finished, tabs appear | `.easeInOut(duration: 0.35)`, opacity transition |

---

## 5. Sound

### 5.1 How sounds are made

There are no audio files. Every cue is synthesized once at first use into a mono 48 kHz `AVAudioPCMBuffer` by `ToneSynth`, then played on a round robin pool of 6 `AVAudioPlayerNode`s (`scheduleBuffer(..., options: .interrupts)`). The continuous squish is a live `AVAudioSourceNode`. Main mixer starts at 0.85.

Design rules (from the source): one family in D major pentatonic around D3 to D5 with one timbre (rounded sines, a soft sub octave, a gentle low pass); form follows the gesture (taps are single droplets, wearing is a rising pour, taking off falls, drags slosh, releases wobble); the more often a cue plays the shorter and quieter it is; 8 to 25 ms attacks, long rounded decays, everything low passed under about 2 kHz; low notes carry harmonics 2 to 4 so phone speakers imply the bass; water droplets glide **up** in pitch as they decay.

Synthesis per note: exponential pitch glide `f = freq × (from / freq)^exp(−t / glide)`; optional vibrato `× (1 + depth × exp(−t / decay) × sin(2π rate t))`; raised cosine attack then exponential decay `exp(−(t − attack) / decay)`; optional tremolo `× (1 − depth (0.5 + 0.5 sin 2π rate t))`; signal = `sub × sin(phase / 2) + Σ level × sin(phase × multiple)`; optional dark noise (xorshift white noise through a one pole low pass at `noiseCutoff`, times `noise × 3`). Then the whole buffer goes through a two pole low pass at the recipe cutoff, is normalized to the recipe's peak, and the last 30 ms fade out.

Partial sets: `water = [(1, 1), (2, 0.16), (3, 0.04)]` (default), `warm = [(1, 1), (2, 0.55), (3, 0.28), (4, 0.1)]`, `glass = [(1, 1), (2, 0.2), (3.01, 0.05)]` (defined, unused). A `drop(start, f, amp, decay)` is a water droplet: glides up from `0.62 f` with glide 0.035, attack 0.008, sub 0.2.

Pitches (Hz): D2 73.42, A2 110, D3 146.83, E3 164.81, F♯3 185, A3 220, B3 246.94, D4 293.66, E4 329.63, F♯4 369.99, A4 440, B4 493.88, D5 587.33.

| Sound | Recipe summary | Length s | Peak | Low pass Hz |
|---|---|---|---|---|
| tap | drop D5, decay 0.06 | 0.22 | 0.14 | 2000 |
| press | drop D4 (0.09) + warm D3 note (amp 0.55, decay 0.06, sub 0.5) | 0.3 | 0.22 | 1500 |
| tab | drop F♯4, decay 0.07 | 0.24 | 0.15 | 1800 |
| toggleOn | drop D4 (amp 0.8) then A4 at 0.07 s | 0.36 | 0.18 | 1800 |
| toggleOff | drop A4 (amp 0.8) then D4 at 0.07 s | 0.36 | 0.17 | 1800 |
| wear | warm D3 swell (attack 0.08, tremolo 5.5 Hz 0.25) + drops D4, F♯4, A4 at 0.03, 0.11, 0.19 | 0.85 | 0.26 | 1900 |
| takeOff | warm D3 falling from F♯3 + drops A4, F♯4, D4 at 0, 0.08, 0.16 | 0.75 | 0.24 | 1600 |
| poke | warm bloop B3 from E3, vibrato 7 Hz 0.04 | 0.3 | 0.22 | 1300 |
| pop | drops A4 then D5 (amp 0.45) at 0.06 | 0.34 | 0.2 | 2000 |
| land | warm D3 from F♯3, decay 0.08 | 0.26 | 0.2 | 900 |
| boingSmall | warm B3 from E4, vibrato 6 Hz 0.07 | 0.7 | 0.24 | 1300 |
| boingBig | warm F♯3 from D4, vibrato 4.8 Hz 0.1 | 1.1 | 0.28 | 1150 |
| chime | warm D3 pad (tremolo 4.5 Hz 0.3) + drops D4, F♯4, A4, D5 at 0, 0.08, 0.16, 0.26 | 1.5 | 0.26 | 2100 |
| tick(step) | lub dub heartbeat: warm f from 1.25 f, then 0.9 f from 1.1 f at 0.17 s; `f = 98 × 2^(0.5 x)`, x = step / 7 | 0.5 | 0.22 + 0.08 x | 700 + 400 x |
| met | stone in a lake (see 3.6 and the code) | 2.1 | 0.3 | 950 |
| talk | warm D3 (tremolo 5 Hz) + drops D4, F♯4 at 0.02, 0.12 | 0.8 | 0.24 | 1700 |
| celebrate | warm D3 pad (tremolo 4 Hz 0.3) + drops D4, F♯4, A4, B4, D5 every 0.08 s | 1.6 | 0.27 | 2100 |
| error | warm A3 then F♯3 at 0.14 | 0.6 | 0.22 | 1100 |

There are 8 tick steps (`tickSteps = 8`); the step is `round(closeness × 7)`.

**Verbatim** (`Core/Feedback/ToneSynth.swift`, complete):

```swift
// Core/Feedback/ToneSynth.swift lines 24 to 238
enum ToneSynth {
    struct Note {
        var start: Double = 0
        var freq: Double
        /// Glide from `from` to `freq` with this time constant (seconds).
        var from: Double? = nil
        var glide: Double = 0.04
        var attack: Double = 0.014
        var decay: Double = 0.12
        var amp: Double = 1
        /// (multiple of freq, level)
        var partials: [(Double, Double)] = ToneSynth.water
        /// Level of a sine one octave below (felt on headphones, implied on speakers).
        var sub: Double = 0.3
        /// Wobble (rate Hz, depth as a fraction of freq, decay seconds): jelly and water.
        var vibrato: (rate: Double, depth: Double, decay: Double)? = nil
        /// Slow amplitude ripple (rate Hz, depth 0...1): liquid movement.
        var tremolo: (rate: Double, depth: Double)? = nil
        /// Level of soft, dark noise under the note (a watery wash), shaped by
        /// the same envelope and filtered low before the master low pass.
        var noise: Double = 0
        var noiseCutoff: Double = 420
    }

    // D major pentatonic, low and warm
    static let D2 = 73.42, A2 = 110.0
    static let D3 = 146.83, E3 = 164.81, Fs3 = 185.0, A3 = 220.0, B3 = 246.94
    static let D4 = 293.66, E4 = 329.63, Fs4 = 369.99, A4 = 440.0, B4 = 493.88, D5 = 587.33

    static let water: [(Double, Double)] = [(1, 1), (2, 0.16), (3, 0.04)]
    /// Low notes: strong low harmonics so phone speakers still say "bass".
    static let warm: [(Double, Double)] = [(1, 1), (2, 0.55), (3, 0.28), (4, 0.1)]
    static let glass: [(Double, Double)] = [(1, 1), (2, 0.2), (3.01, 0.05)]

    static func render(_ id: SoundID, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let (notes, length, peak, cutoff) = recipe(id)
        return render(notes, length: length, peak: peak, cutoff: cutoff, format: format)
    }

    /// A water droplet: rises in pitch as it rings out.
    static func drop(_ start: Double, _ f: Double, amp: Double = 1, decay: Double = 0.1) -> Note {
        Note(start: start, freq: f, from: f * 0.62, glide: 0.035, attack: 0.008, decay: decay, amp: amp, sub: 0.2)
    }

    // MARK: Recipes (notes, length s, peak level, low pass cutoff Hz)

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func recipe(_ id: SoundID) -> ([Note], Double, Double, Double) {
        switch id {
        case .tap:
            return ([drop(0, D5, decay: 0.06)], 0.22, 0.14, 2000)
        case .press:
            return ([
                drop(0, D4, decay: 0.09),
                Note(freq: D3, attack: 0.01, decay: 0.06, amp: 0.55, partials: warm, sub: 0.5),
            ], 0.3, 0.22, 1500)
        case .tab:
            return ([drop(0, Fs4, decay: 0.07)], 0.24, 0.15, 1800)
        case .toggleOn:
            return ([drop(0, D4, amp: 0.8, decay: 0.07), drop(0.07, A4, decay: 0.1)], 0.36, 0.18, 1800)
        case .toggleOff:
            return ([drop(0, A4, amp: 0.8, decay: 0.07), drop(0.07, D4, decay: 0.1)], 0.36, 0.17, 1800)
        case .wear:
            // A pour: droplets climbing over a warm swell
            return ([
                Note(freq: D3, attack: 0.08, decay: 0.3, amp: 0.7, partials: warm, sub: 0.5, tremolo: (5.5, 0.25)),
                drop(0.03, D4, amp: 0.8), drop(0.11, Fs4, amp: 0.8), drop(0.19, A4, decay: 0.22),
            ], 0.85, 0.26, 1900)
        case .takeOff:
            return ([
                Note(freq: D3, from: Fs3, glide: 0.12, attack: 0.05, decay: 0.25, amp: 0.7, partials: warm, sub: 0.5),
                drop(0, A4, amp: 0.7), drop(0.08, Fs4, amp: 0.7), drop(0.16, D4, decay: 0.18),
            ], 0.75, 0.24, 1600)
        case .poke:
            // A squishy bloop
            return ([Note(freq: B3, from: E3, glide: 0.035, attack: 0.012, decay: 0.1, partials: warm, sub: 0.4,
                          vibrato: (rate: 7, depth: 0.04, decay: 0.08))], 0.3, 0.22, 1300)
        case .pop:
            return ([drop(0, A4, decay: 0.08), drop(0.06, D5, amp: 0.45, decay: 0.07)], 0.34, 0.2, 2000)
        case .land:
            return ([Note(freq: D3, from: Fs3, glide: 0.03, attack: 0.01, decay: 0.08, partials: warm, sub: 0.5)],
                    0.26, 0.2, 900)
        case .boingSmall:
            return ([Note(freq: B3, from: E4, glide: 0.06, attack: 0.012, decay: 0.24, partials: warm, sub: 0.35,
                          vibrato: (rate: 6, depth: 0.07, decay: 0.26))], 0.7, 0.24, 1300)
        case .boingBig:
            return ([Note(freq: Fs3, from: D4, glide: 0.08, attack: 0.014, decay: 0.38, partials: warm, sub: 0.45,
                          vibrato: (rate: 4.8, depth: 0.1, decay: 0.4))], 1.1, 0.28, 1150)
        case .chime:
            // A match appears: a rising, bubbly chord over a soft pad
            return ([
                Note(freq: D3, attack: 0.12, decay: 0.45, amp: 0.55, partials: warm, sub: 0.4, tremolo: (4.5, 0.3)),
                drop(0.0, D4, amp: 0.7, decay: 0.3), drop(0.08, Fs4, amp: 0.7, decay: 0.3),
                drop(0.16, A4, amp: 0.75, decay: 0.35), drop(0.26, D5, amp: 0.5, decay: 0.45),
            ], 1.5, 0.26, 2100)
        case .tick(let step):
            // A muffled heartbeat under water: lub dub, faster and a bit higher as they come closer
            let x = Double(step) / Double(SoundID.tickSteps - 1)
            let f = 98 * pow(2, x * 0.5) // about G2 to D3
            return ([
                Note(freq: f, from: f * 1.25, glide: 0.02, attack: 0.012, decay: 0.09, partials: warm, sub: 0.6),
                Note(start: 0.17, freq: f * 0.9, from: f * 1.1, glide: 0.02, attack: 0.012, decay: 0.08,
                     amp: 0.6, partials: warm, sub: 0.6),
            ], 0.5, 0.22 + 0.08 * x, 700 + 400 * x)
        case .met:
            // We finally met: a stone dropping into a lake. A low, soft thump
            // that sinks, then a dark wash that spreads and settles, with a few
            // slow ripples drifting outward. Relief, not a fanfare.
            return ([
                // The stone: a round low hit, falling a little as it lands
                Note(freq: D2, from: A2, glide: 0.06, attack: 0.014, decay: 0.28, partials: warm, sub: 0.35),
                // Its body on small speakers
                Note(freq: D3, from: Fs3, glide: 0.07, attack: 0.02, decay: 0.32, amp: 0.45, partials: warm, sub: 0.5),
                // The water closing over it: a slow swell of low noise and a soft fifth
                Note(start: 0.04, freq: A2, attack: 0.3, decay: 0.85, amp: 0.4,
                     partials: [(1, 0.35), (1.5, 0.18), (2, 0.1)], sub: 0.2, tremolo: (3.2, 0.35),
                     noise: 1.4, noiseCutoff: 380),
                // Ripples spreading out: each one later, lower and quieter
                drop(0.2, A3, amp: 0.3, decay: 0.22),
                drop(0.42, Fs3, amp: 0.22, decay: 0.28),
                drop(0.7, D3, amp: 0.15, decay: 0.36),
            ], 2.1, 0.3, 950)
        case .talk:
            return ([
                Note(freq: D3, attack: 0.06, decay: 0.3, amp: 0.6, partials: warm, sub: 0.4, tremolo: (5, 0.25)),
                drop(0.02, D4, decay: 0.16), drop(0.12, Fs4, decay: 0.22),
            ], 0.8, 0.24, 1700)
        case .celebrate:
            // Saved: a warm pour that settles
            var notes: [Note] = [
                Note(freq: D3, attack: 0.15, decay: 0.6, amp: 0.6, partials: warm, sub: 0.45, tremolo: (4, 0.3)),
            ]
            for (i, f) in [D4, Fs4, A4, B4, D5].enumerated() {
                notes.append(drop(Double(i) * 0.08, f, amp: i == 4 ? 0.7 : 0.75, decay: i == 4 ? 0.5 : 0.18))
            }
            return (notes, 1.6, 0.27, 2100)
        case .error:
            return ([
                Note(freq: A3, attack: 0.015, decay: 0.12, partials: warm, sub: 0.4),
                Note(start: 0.14, freq: Fs3, attack: 0.015, decay: 0.16, partials: warm, sub: 0.4),
            ], 0.6, 0.22, 1100)
        }
    }

    // MARK: Rendering

    static func render(_ notes: [Note], length: Double, peak: Double, cutoff: Double,
                       format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let sr = format.sampleRate
        let frames = AVAudioFrameCount(length * sr)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let out = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = frames
        let n = Int(frames)
        for i in 0..<n { out[i] = 0 }

        for note in notes {
            let first = Int(note.start * sr)
            guard first < n else { continue }
            var phase = 0.0
            // Noise: a fixed seed so the sound is the same every launch
            var seed: UInt32 = 0x9E37_79B9 &+ UInt32(first)
            var dark = 0.0
            let kNoise = 1 - exp(-2 * .pi * note.noiseCutoff / sr)
            for i in first..<n {
                let t = Double(i - first) / sr
                // Exponential glide in pitch (sounds even across octaves)
                var f = note.freq
                if let from = note.from {
                    f = note.freq * pow(from / note.freq, exp(-t / note.glide))
                }
                if let v = note.vibrato {
                    f *= 1 + v.depth * exp(-t / v.decay) * sin(2 * .pi * v.rate * t)
                }
                phase += 2 * .pi * f / sr
                // Rounded attack (raised cosine), exponential decay
                var a = t < note.attack
                    ? 0.5 - 0.5 * cos(.pi * t / note.attack)
                    : exp(-(t - note.attack) / note.decay)
                if a < 0.0004 && t > note.attack { break }
                if let tr = note.tremolo { a *= 1 - tr.depth * (0.5 + 0.5 * sin(2 * .pi * tr.rate * t)) }
                var s = sin(phase * 0.5) * note.sub
                for (mult, level) in note.partials { s += sin(phase * mult) * level }
                if note.noise > 0 {
                    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
                    let white = Double(seed) / Double(UInt32.max) * 2 - 1
                    dark += kNoise * (white - dark)
                    s += dark * note.noise * 3 // the low pass takes most of its level
                }
                out[i] += Float(s * a * note.amp)
            }
        }

        // Two pole low pass (two cascaded one poles): rounds every edge
        let k = Float(1 - exp(-2 * .pi * cutoff / sr))
        var y1: Float = 0, y2: Float = 0
        for i in 0..<n {
            y1 += k * (out[i] - y1)
            y2 += k * (y1 - y2)
            out[i] = y2
        }

        // Normalize to the recipe's level and fade the tail to avoid clicks
        var maxValue: Float = 0
        for i in 0..<n { maxValue = max(maxValue, abs(out[i])) }
        let gain = maxValue > 0 ? Float(peak) / maxValue : 0
        let fade = min(n, Int(0.03 * sr))
        for i in 0..<n {
            var g = gain
            if i >= n - fade { g *= Float(n - i) / Float(fade) }
            out[i] *= g
        }
        return buffer
    }
}
```

### 5.2 The live squish voice

A low watery slosh while dragging the avatar. Parameters written from the main thread (stretch and motion, each 0...1), smoothed on the audio thread with a 25 ms one pole. Target amplitude `0.2 × √stretch × (0.15 + 0.85 motion)`, so holding still is nearly silent; pitch `98 + 150 stretch` Hz with a 4.5 Hz, 5% wobble; harmonics `0.35 sin(φ/2) + sin φ + 0.5 sin 2φ + 0.22 sin 3φ`, amplitude ripple `0.8 + 0.2 sin(2 wobble)`; two pole low pass opening from 450 to 1550 Hz with stretch. It reports silence when both target and current amplitude are under 0.0005. Motion is the finger's stretch speed: `speed = min(1, |Δstretch| / dt / 2.5)`, smoothed with 0.6 rising and 0.2 falling.

**Verbatim** (`Core/Feedback/SoundEngine.swift` 124 to 201):

```swift
// Core/Feedback/SoundEngine.swift lines 124 to 201
/// The live squish voice: a low, watery slosh whose pitch and brightness follow the stretch
/// and whose loudness follows how fast the finger moves, so holding still is
/// nearly silent. Parameters are written from the main thread and read, smoothed,
/// on the audio thread (aligned Float writes, no locks, no allocation).
final class SquishVoice {
    private let params: UnsafeMutablePointer<Float> // [stretch, motion]
    private let state: UnsafeMutablePointer<Float>  // [phase, wobble, amp, freq, lp1, lp2], audio thread only
    private(set) var isActive = false

    init() {
        params = .allocate(capacity: 2)
        params.initialize(repeating: 0, count: 2)
        state = .allocate(capacity: 6)
        state.initialize(repeating: 0, count: 6)
        state[3] = 110
    }

    deinit {
        params.deallocate()
        state.deallocate()
    }

    func set(stretch: Double, motion: Double) {
        params[0] = Float(max(0, min(1, stretch)))
        params[1] = Float(max(0, min(1, motion)))
        isActive = stretch > 0.001
    }

    func makeNode(sampleRate: Double) -> AVAudioSourceNode {
        Self.node(params: params, state: state, sampleRate: sampleRate)
    }

    private static func node(params: UnsafeMutablePointer<Float>, state: UnsafeMutablePointer<Float>,
                             sampleRate: Double) -> AVAudioSourceNode {
        let sr = Float(sampleRate)
        let smooth = 1 - exp(-1 / (0.025 * sr)) // about 25 ms
        let twoPi = Float.pi * 2
        return AVAudioSourceNode { isSilence, _, frameCount, bufferList in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            let stretch = params[0], motion = params[1]
            var phase = state[0], wobble = state[1], amp = state[2], freq = state[3]
            var lp1 = state[4], lp2 = state[5]
            defer { state[0] = phase; state[1] = wobble; state[2] = amp; state[3] = freq; state[4] = lp1; state[5] = lp2 }
            let targetAmp = 0.2 * stretch.squareRoot() * (0.15 + 0.85 * motion)
            let targetFreq = 98 + 150 * stretch // G2 up to about D3/E3
            // The filter opens as it stretches: muffled slosh to a brighter one
            let cutoff = 450 + 1100 * stretch
            let k = 1 - exp(-twoPi * cutoff / sr)
            if targetAmp < 0.0005 && amp < 0.0005 {
                amp = 0
                for buffer in buffers {
                    memset(buffer.mData, 0, Int(buffer.mDataByteSize))
                }
                isSilence.pointee = true
                return noErr
            }
            for frame in 0..<Int(frameCount) {
                amp += (targetAmp - amp) * smooth
                freq += (targetFreq - freq) * smooth
                wobble += twoPi * 4.5 / sr
                if wobble > twoPi { wobble -= twoPi }
                let f = freq * (1 + 0.05 * sin(wobble))
                phase += twoPi * f / sr
                if phase > twoPi { phase -= twoPi }
                // Warm harmonics so phone speakers still carry the low body, plus a liquid ripple
                let raw = (0.35 * sin(phase * 0.5) + sin(phase) + 0.5 * sin(2 * phase) + 0.22 * sin(3 * phase))
                    * (0.8 + 0.2 * sin(wobble * 2)) * amp
                lp1 += k * (raw - lp1)
                lp2 += k * (lp1 - lp2)
                let s = lp2
                for buffer in buffers {
                    buffer.mData?.assumingMemoryBound(to: Float.self)[frame] = s
                }
            }
            return noErr
        }
    }
}
```

### 5.3 Events, volumes and throttles

All cues go through `Feedback.shared.play(cue)`; views never touch audio or haptics directly. Sounds and haptics each have a Settings switch (`feedback.sounds`, `feedback.haptics`, default on) and a 0...1 level slider (`feedback.soundLevel`, `feedback.hapticLevel`, default 1).

| Cue | Trigger | Sound (volume) | Haptic | Throttle |
|---|---|---|---|---|
| tap | generic tap | tap (0.8) | light impact 0.5 | 0.05 s |
| buttonPress | any styled button goes down | press (0.8) | soft impact 0.7 | 0.06 s |
| tabSwitch | tab selection changes | tab (0.7) | selection tick | 0.08 s |
| toggle(on) | Settings toggles | toggleOn or toggleOff (1) | rigid impact 0.6 on, 0.4 off | none |
| detent | badge preview pinch > 1.15 or lift < −70 (letting go would wear it) | tap (0.6) | selection tick | 0.15 s |
| wear | badge goes full screen | wear (1) | pattern (0, 0.5, 0.3), (0.12, 0.8, 0.5) | none |
| takeOff | badge leaves full screen | takeOff (1) | pattern (0, 0.7, 0.4), (0.1, 0.4, 0.2) | none |
| avatarPoke | finger down on avatar | poke (0.8) | soft impact 0.55 | 0.08 s |
| avatarHop | tap on avatar | pop (1) | pattern (0, 0.6, 0.6) | none |
| avatarLand | 0.5 s after the hop | land (0.7) | soft impact 0.45 | 0.15 s |
| avatarRelease(x) | let go after a drag | boingBig if x > 0.4 else boingSmall (0.35 + 0.65 x) | pattern (0, i, 0.5), (0.16, 0.55 i, 0.35), (0.31, 0.28 i, 0.25), i = 0.35 + 0.6 x | none |
| matchAppears | match mode starts or match changes; also played when the haptic Strength slider is released (sound too, if sounds are on) | chime (1) | pattern (0, 0.55, 0.5), (0.11, 0.85, 0.7) | 3 s |
| approachTick(c, prominent) | heartbeat loop | tick(round(7c)) at (prominent ? 0.55 : 0.35) + 0.35 c | pattern (0, i, s), (0.13, 0.6 i, 0.7 s), i = 0.3 + 0.65 c, s = 0.15 + 0.5 c | none |
| met | meet moment (+0.5 s) | met (1) | `settle()` | 3 s |
| talkStart | talking starts, no meet in 30 s | talk (1) | pattern (0, 0.6, 0.3), (0.1, 0.8, 0.45) | 2 s |
| saved | connected | celebrate (1) | pattern (0, 0.5, 0.5), (0.075, 0.6, 0.55), (0.15, 0.7, 0.6), (0.225, 1, 0.75) | 2 s |
| error | failures | error (1) | notification error | none |

Pattern tuples are (time s, intensity, sharpness) before gain and the sharpness scale (section 6).

Volume handling (in `SoundEngine.play`): `mainMixer.outputVolume = 0.4 + 0.6 × level` and `node.volume = min(1, volume × (0.6 + 1.2 × level))`. At the default level 1 that is mixer 1.0 and up to 1.8 × the authored volume, capped at 1.

**Verbatim** (`Core/Feedback/Feedback.swift` 7 to 185, and `FeedbackCue.swift`):

```swift
// Core/Feedback/Feedback.swift lines 7 to 185
@MainActor
final class Feedback {
    static let shared = Feedback()

    static let soundsKey = "feedback.sounds"
    static let hapticsKey = "feedback.haptics"
    /// Settings sliders, 0...1. Default all the way up: events are loud.
    static let soundLevelKey = "feedback.soundLevel"
    static let hapticLevelKey = "feedback.hapticLevel"

    /// Sound level: 0 is quiet (40% of the old mix), 1 is the loudest the cues go.
    static var soundLevel: Double { UserDefaults.standard.double(forKey: soundLevelKey) }
    /// Haptic strength multiplier: 0.5x at 0, 1.6x at 1 (capped at full strength).
    static var hapticGain: Double { 0.5 + 1.1 * UserDefaults.standard.double(forKey: hapticLevelKey) }

    private lazy var sound = SoundEngine()
    private let haptics = HapticEngine()
    private var lastPlayed: [String: Double] = [:]

    // Squish tracking (for motion = how fast the stretch changes)
    private var squishing = false
    private var lastStretch = 0.0
    private var lastStretchTime = 0.0
    private var motion = 0.0
    private var lastDetent = 0

    private init() {
        UserDefaults.standard.register(defaults: [Self.soundsKey: true, Self.hapticsKey: true,
                                                  Self.soundLevelKey: 1.0, Self.hapticLevelKey: 1.0])
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Feedback.shared.suspend() }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Feedback.shared.prepare() }
        }
    }

    var soundsOn: Bool { UserDefaults.standard.bool(forKey: Self.soundsKey) }
    var hapticsOn: Bool { UserDefaults.standard.bool(forKey: Self.hapticsKey) }

    /// Warm up the haptic generators (and render the sounds) before the first touch.
    func prepare() {
        if hapticsOn { haptics.prepare() }
        if soundsOn { sound.warmUp() }
    }

    func play(_ cue: FeedbackCue) {
        let s = soundsOn, h = hapticsOn
        guard s || h else { return }
        switch cue {
        case .tap:
            guard throttle("tap", 0.05) else { return }
            if s { sound.play(.tap, volume: 0.8) }
            if h { haptics.impact(.light, intensity: 0.5) }
        case .buttonPress:
            guard throttle("press", 0.06) else { return }
            if s { sound.play(.press, volume: 0.8) }
            if h { haptics.impact(.soft, intensity: 0.7) }
        case .tabSwitch:
            guard throttle("tab", 0.08) else { return }
            if s { sound.play(.tab, volume: 0.7) }
            if h { haptics.selectionTick() }
        case .toggle(let on):
            if s { sound.play(on ? .toggleOn : .toggleOff) }
            if h { haptics.impact(.rigid, intensity: on ? 0.6 : 0.4) }
        case .detent:
            guard throttle("detent", 0.15) else { return }
            if s { sound.play(.tap, volume: 0.6) }
            if h { haptics.selectionTick() }
        case .wear:
            if s { sound.play(.wear) }
            if h { haptics.pattern([(0, 0.5, 0.3), (0.12, 0.8, 0.5)]) }
        case .takeOff:
            if s { sound.play(.takeOff) }
            if h { haptics.pattern([(0, 0.7, 0.4), (0.1, 0.4, 0.2)]) }
        case .avatarPoke:
            guard throttle("poke", 0.08) else { return }
            if s { sound.play(.poke, volume: 0.8) }
            if h { haptics.impact(.soft, intensity: 0.55) }
        case .avatarHop:
            if s { sound.play(.pop) }
            if h { haptics.pattern([(0, 0.6, 0.6)]) }
        case .avatarLand:
            guard throttle("land", 0.15) else { return }
            if s { sound.play(.land, volume: 0.7) }
            if h { haptics.impact(.soft, intensity: 0.45) }
        case .avatarRelease(let stretch):
            let x = max(0, min(1, stretch))
            if s { sound.play(x > 0.4 ? .boingBig : .boingSmall, volume: Float(0.35 + 0.65 * x)) }
            if h {
                // A bounce that decays like the jelly spring
                let i = 0.35 + 0.6 * x
                haptics.pattern([(0, i, 0.5), (0.16, i * 0.55, 0.35), (0.31, i * 0.28, 0.25)])
            }
        case .matchAppears:
            guard throttle("match", 3) else { return }
            if s { sound.play(.chime) }
            if h { haptics.pattern([(0, 0.55, 0.5), (0.11, 0.85, 0.7)]) }
        case .approachTick(let closeness, let prominent):
            let c = max(0, min(1, closeness))
            let step = Int((c * Double(SoundID.tickSteps - 1)).rounded())
            if s { sound.play(.tick(step), volume: Float((prominent ? 0.55 : 0.35) + 0.35 * c)) }
            if h {
                let i = 0.3 + 0.65 * c, sharp = 0.15 + 0.5 * c
                haptics.pattern([(0, i, sharp), (0.13, i * 0.6, sharp * 0.7)])
            }
        case .met:
            guard throttle("met", 3) else { return }
            if s { sound.play(.met) }
            if h { haptics.settle() }
        case .talkStart:
            guard throttle("talk", 2) else { return }
            if s { sound.play(.talk) }
            if h { haptics.pattern([(0, 0.6, 0.3), (0.1, 0.8, 0.45)]) }
        case .saved:
            guard throttle("saved", 2) else { return }
            if s { sound.play(.celebrate) }
            if h {
                haptics.pattern([(0, 0.5, 0.5), (0.075, 0.6, 0.55), (0.15, 0.7, 0.6), (0.225, 1, 0.75)])
            }
        case .error:
            if s { sound.play(.error) }
            if h { haptics.failure() }
        }
    }

    // MARK: Continuous squish

    func beginSquish() {
        guard !squishing else { return }
        squishing = true
        lastStretch = 0
        lastStretchTime = CACurrentMediaTime()
        motion = 0
        lastDetent = 0
        if soundsOn { sound.startSquish() }
        if hapticsOn { haptics.startSquish() }
    }

    /// Call on every drag change with the stretch (0...1).
    func squish(stretch: Double) {
        guard squishing else { return }
        let now = CACurrentMediaTime()
        let dt = max(1.0 / 240, now - lastStretchTime)
        let speed = min(1, abs(stretch - lastStretch) / dt / 2.5) // 0...1
        motion += (speed - motion) * (speed > motion ? 0.6 : 0.2)
        lastStretch = stretch
        lastStretchTime = now
        if soundsOn { sound.squish.set(stretch: stretch, motion: motion) }
        if hapticsOn {
            haptics.setSquish(stretch: stretch)
            // Little rubbery detents every so often as it stretches further
            let detent = Int(stretch / 0.18)
            if detent > lastDetent { haptics.pattern([(0, 0.25 + 0.4 * stretch, 0.6)]) }
            lastDetent = detent
        }
    }

    func endSquish() {
        guard squishing else { return }
        squishing = false
        sound.stopSquish()
        haptics.stopSquish()
    }

    private func suspend() {
        endSquish()
        sound.suspend()
    }

    /// False when the same cue played less than `interval` seconds ago.
    private func throttle(_ key: String, _ interval: Double) -> Bool {
        let now = CACurrentMediaTime()
        if let last = lastPlayed[key], now - last < interval { return false }
        lastPlayed[key] = now
        return true
    }
}
```

```swift
// Core/Feedback/FeedbackCue.swift lines 6 to 47
enum FeedbackCue {
    // Controls
    case tap
    case buttonPress
    case tabSwitch
    case toggle(on: Bool)
    /// Crossing a gesture threshold ("let go now to wear it").
    case detent

    // Wearing
    case wear
    case takeOff

    // Avatar touch
    case avatarPoke
    /// Tap: the avatar hops (pop on take off).
    case avatarHop
    /// The hop lands.
    case avatarLand
    /// Let go after a drag: a jelly boing, bigger for a bigger stretch (0...1).
    case avatarRelease(stretch: Double)

    // Approach
    case matchAppears
    /// One heartbeat while a match approaches; higher and stronger as closeness (0...1) rises.
    case approachTick(closeness: Double, prominent: Bool)
    /// We finally met (came within talking distance): relief, a stone settling into a lake.
    case met
    case talkStart
    case saved

    case error
}

/// Rendered sounds, one buffer each (approach ticks come in pitch steps).
enum SoundID: Hashable {
    case tap, press, tab, toggleOn, toggleOff, wear, takeOff
    case poke, pop, land, boingSmall, boingBig
    case chime, tick(Int), met, talk, celebrate, error

    static let tickSteps = 8
}
```

### 5.4 Audio session rules and recording coexistence

* UI sounds use the `.ambient` category with `.mixWithOthers`: the ring/silent switch mutes them and other apps' audio keeps playing.
* While a conversation is recorded, the recorder owns the session: `.playAndRecord`, mode `.default` (not `.measurement`, which turned the speaker way down), options `.duckOthers, .defaultToSpeaker`, activated with `.notifyOthersOnDeactivation`. The sound engine detects `.playAndRecord` and plays on it as is, never changing the category (that would cut the recording, and staying silent lost every cue during conversations).
* Recording starts no earlier than 1.8 s after the meet so the meet sound rings out on the speaker first.
* When recording stops, the recorder deactivates the session, sets it back to `.ambient` with `.mixWithOthers`, and posts `audioSessionReleased`. The sound engine restarts on that notification (before this fix the engine kept "running" on a dead session and was silent until relaunch).
* The engine also restarts on `AVAudioEngineConfigurationChange` (route change: immediately), interruption ended, and media services reset.
* The engine is warmed up at launch and on becoming active (so the first short cue is not swallowed), and stopped in the background (`didEnterBackground` also ends any squish).

**Verbatim** (`SoundEngine.swift` 60 to 121 and `ConversationRecorder.swift` excerpts):

```swift
// Core/Feedback/SoundEngine.swift lines 60 to 121
    /// Bring the audio hardware up ahead of the first sound (app launch and
    /// foreground), so short cues are never swallowed by a cold start.
    func warmUp() { _ = ensureRunning() }

    func play(_ id: SoundID, volume: Float = 1) {
        guard let buffer = buffers[id], ensureRunning() else { return }
        let node = players[nextPlayer]
        nextPlayer = (nextPlayer + 1) % players.count
        // The Settings level scales every cue (up to 1.8x the authored volume, capped)
        // and the master mix, so a crowded room can still hear the badge.
        let level = Float(Feedback.soundLevel)
        engine.mainMixerNode.outputVolume = 0.4 + 0.6 * level
        node.volume = min(1, volume * (0.6 + 1.2 * level))
        node.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !node.isPlaying { node.play() }
    }

    func startSquish() {
        guard ensureRunning() else { return }
        squish.set(stretch: 0, motion: 0)
    }

    func stopSquish() { squish.set(stretch: 0, motion: 0) }

    /// Stop the audio hardware in the background. While the app is active the
    /// engine stays up: restarting it on demand dropped short cues (the first
    /// tap after a pause was silent while the output woke up).
    func suspend() {
        squish.set(stretch: 0, motion: 0)
        if engine.isRunning { engine.stop() }
    }

    /// Forget the session and stop the engine; come back up now or on the next sound.
    private func restart(now: Bool) {
        sessionReady = false
        players.forEach { $0.stop() }
        if engine.isRunning { engine.stop() }
        if now { _ = ensureRunning() }
    }

    private func ensureRunning() -> Bool {
        let session = AVAudioSession.sharedInstance()
        // While a conversation is being recorded the recorder owns the session
        // (play and record, to the speaker). Play on it as it is: changing the
        // category here would cut the recording, and staying silent made every
        // cue vanish for the whole conversation.
        let recording = session.category == .playAndRecord
        if !recording, !sessionReady || session.category != .ambient {
            do {
                try session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
                try session.setActive(true)
                sessionReady = true
            } catch {
                return false
            }
        }
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch { return false }
        }
        return true
    }
```

```swift
// Core/Recording/ConversationRecorder.swift lines 43 to 48
        do {
            let audio = AVAudioSession.sharedInstance()
            // .default, not .measurement: measurement mode turns the speaker way down, so cues
            // during a conversation were close to silent.
            try audio.setCategory(.playAndRecord, mode: .default, options: [.duckOthers, .defaultToSpeaker])
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
```

```swift
// Core/Recording/ConversationRecorder.swift lines 108 to 112
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        // Hand the session back to the UI sounds (ambient: the silent switch mutes them)
        try? AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        // The session was deactivated above: the UI sounds must bring it back up.
        await MainActor.run { NotificationCenter.default.post(name: .audioSessionReleased, object: nil) }
```

---

## 6. Haptics

### 6.1 Gain mapping

* `hapticGain = 0.5 + 1.1 × hapticLevel` (0.5 × at level 0, 1.6 × at the default level 1).
* UIKit impacts (`light`, `soft`, `rigid` generators): `intensity = clamp(intensity × gain, 0, 1)`.
* Core Haptics transient patterns: `intensity = min(1, i × gain)`, `sharpness = s × 0.45` (deliberately round, not clicky). If Core Haptics is unavailable, a pattern falls back to one soft impact at the first tap's intensity.
* `settle()` (met) and the continuous squish use fixed values and are **not** scaled by the gain.
* Selection ticks and the error notification use the system generators.
* Engine: `playsHapticsOnly = true`, auto shutdown on, restarted lazily after reset or stop.

### 6.2 Patterns

Effective values at the default gain (1.6) are shown in brackets; intensity is capped at 1.

| Pattern | Events (time s: intensity, sharpness as authored) | Effective at default |
|---|---|---|
| wear | 0: 0.5, 0.3; 0.12: 0.8, 0.5 | 0.8 / 0.135; 1 / 0.225 |
| takeOff | 0: 0.7, 0.4; 0.1: 0.4, 0.2 | 1 / 0.18; 0.64 / 0.09 |
| avatarHop | 0: 0.6, 0.6 | 0.96 / 0.27 |
| avatarRelease(x) | 0: i, 0.5; 0.16: 0.55 i, 0.35; 0.31: 0.28 i, 0.25; i = 0.35 + 0.6 x | decays like the jelly spring |
| squish detent | each time stretch crosses another multiple of 0.18: 0.25 + 0.4 stretch, 0.6 | |
| matchAppears | 0: 0.55, 0.5; 0.11: 0.85, 0.7 | 0.88 / 0.225; 1 / 0.315 |
| approachTick(c) | 0: i, s; 0.13: 0.6 i, 0.7 s; i = 0.3 + 0.65 c, s = 0.15 + 0.5 c | lub dub |
| talkStart | 0: 0.6, 0.3; 0.1: 0.8, 0.45 | 0.96 / 0.135; 1 / 0.2 |
| saved | 0: 0.5, 0.5; 0.075: 0.6, 0.55; 0.15: 0.7, 0.6; 0.225: 1, 0.75 | rising four step roll |
| settle (met) | transient 0: 1, 0.08; continuous 0.03 to 1.13: 0.55, 0.02 with intensity control curve 1, 0.5, 0.2, 0 at 0, 0.25, 0.6, 1.1 (curve starts at 0.03); transients 0.32: 0.45, 0.05 and 0.6: 0.35, 0.05 | not gain scaled; sharpness not scaled |
| squish (continuous) | one 30 s continuous event (intensity 1, sharpness 0.25) on an advanced player; dynamic intensity control `0.08 + 0.42 stretch`, sharpness control `−0.35 + 0.3 stretch`, at most 30 updates per second | not gain scaled |

Impacts: tap light 0.5; press soft 0.7; toggle rigid 0.6 or 0.4; poke soft 0.55; land soft 0.45 (all times gain).

**Note**: the settle ripple transients at 0.32 s and 0.6 s fall inside the intensity control curve, which the source comment says also scales them down.

**Verbatim** (`Core/Feedback/HapticEngine.swift` 8 to 133):

```swift
// Core/Feedback/HapticEngine.swift lines 8 to 133
final class HapticEngine {
    private let supported = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    private var engine: CHHapticEngine?
    private var needsStart = true
    private var squishPlayer: CHHapticAdvancedPatternPlayer?
    private var lastSquishUpdate = 0.0

    private let light = UIImpactFeedbackGenerator(style: .light)
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let selection = UISelectionFeedbackGenerator()
    private let notification = UINotificationFeedbackGenerator()

    enum Impact { case light, soft, rigid }

    func prepare() {
        light.prepare(); soft.prepare(); selection.prepare()
    }

    func impact(_ kind: Impact, intensity: Double) {
        let i = CGFloat(max(0, min(1, intensity * Feedback.hapticGain)))
        switch kind {
        case .light: light.impactOccurred(intensity: i)
        case .soft: soft.impactOccurred(intensity: i)
        case .rigid: rigid.impactOccurred(intensity: i)
        }
    }

    func selectionTick() { selection.selectionChanged() }
    func success() { notification.notificationOccurred(.success) }
    func failure() { notification.notificationOccurred(.error) }

    /// Transient taps: (time s, intensity, sharpness). Falls back to one soft impact.
    func pattern(_ taps: [(Double, Double, Double)]) {
        guard let engine = startedEngine() else {
            if let first = taps.first { impact(.soft, intensity: first.1) }
            return
        }
        let events = taps.map { t, i, s in
            CHHapticEvent(eventType: .hapticTransient, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(min(1, i * Feedback.hapticGain))),
                // Round, not clicky: keep sharpness low to match the watery sounds
                CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(s) * 0.45),
            ], relativeTime: t)
        }
        do {
            let player = try engine.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            needsStart = true
        }
    }

    /// We met: one soft, heavy hit, then a low rumble that dies away like
    /// ripples settling. Falls back to a single soft impact.
    func settle() {
        guard let engine = startedEngine() else {
            impact(.soft, intensity: 1)
            return
        }
        let hit = CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.08),
        ], relativeTime: 0)
        let rumble = CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.55),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.02),
        ], relativeTime: 0.03, duration: 1.1)
        // Decay the rumble from full to nothing, fast at first, then slowly
        let fade = CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: [
            CHHapticParameterCurve.ControlPoint(relativeTime: 0, value: 1),
            CHHapticParameterCurve.ControlPoint(relativeTime: 0.25, value: 0.5),
            CHHapticParameterCurve.ControlPoint(relativeTime: 0.6, value: 0.2),
            CHHapticParameterCurve.ControlPoint(relativeTime: 1.1, value: 0),
        ], relativeTime: 0.03)
        // Two faint after ripples (the fade above scales them down too)
        let ripples = [(0.32, 0.45), (0.6, 0.35)].map { t, i in
            CHHapticEvent(eventType: .hapticTransient, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(i)),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.05),
            ], relativeTime: t)
        }
        do {
            let pattern = try CHHapticPattern(events: [hit, rumble] + ripples, parameterCurves: [fade])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            needsStart = true
        }
    }

    // MARK: Continuous squish

    func startSquish() {
        guard let engine = startedEngine() else { return }
        let rumble = CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.25),
        ], relativeTime: 0, duration: 30)
        do {
            let player = try engine.makeAdvancedPlayer(with: CHHapticPattern(events: [rumble], parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
            squishPlayer = player
            setSquish(stretch: 0, force: true)
        } catch {
            needsStart = true
        }
    }

    /// Intensity and sharpness follow the stretch; at most 30 updates a second.
    func setSquish(stretch: Double, force: Bool = false) {
        guard let player = squishPlayer else { return }
        let now = CACurrentMediaTime()
        guard force || now - lastSquishUpdate > 1.0 / 30 else { return }
        lastSquishUpdate = now
        let s = Float(max(0, min(1, stretch)))
        try? player.sendParameters([
            CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: 0.08 + 0.42 * s, relativeTime: 0),
            CHHapticDynamicParameter(parameterID: .hapticSharpnessControl, value: -0.35 + 0.3 * s, relativeTime: 0),
        ], atTime: CHHapticTimeImmediate)
    }

    func stopSquish() {
        try? squishPlayer?.stop(atTime: CHHapticTimeImmediate)
        squishPlayer = nil
    }
```

---

## 7. UX flows

### 7.1 App shell

* `RootView`: signed out shows `SignInView`; signed in shows `MainTabView`. It prepares feedback on appear.
* iPhone Duo hinge (iOS 27, behind a compile flag): closing wears the badge on the outer display; opening takes it off and jumps to the People page of the current match or the person you met last.
* UWB ranging runs only while the badge is worn and the app is active; leaving the app stops it at once; taking the badge off waits 2 s first (so an accidental swipe out and back keeps ranging and recording going).

### 7.2 Sign in (step 1)

`FlowingBackground` full screen, a 130 pt red (`#FF6C6E`) blob avatar (seed 3, curious, excited while busy), then a white Card: "Meet the right people" (General Sans 34 semibold), the body text "Your phone becomes a live badge. Your agent texts you who to meet and remembers them for you.", fields Name ("e.g. Ethan Pan"), Phone number ("(415) 555 0123", with a live footnote confirming the parsed number or asking for a country code), Password (optional, "Optional, to sign in on another phone"), then a yellow Continue button. Continue needs a name and a valid phone. The phone field tidies itself into one format when you leave it. A keyboard toolbar adds "Next" for the phone pad. Field order matters for iOS password autofill (the phone sits right above the password).

### 7.3 Onboarding after sign up

A full screen flow on the cream background with `ProgressDots(count: 3)`: 8 × 8 dots, the current one a 26 pt wide pill, done and current dots black, others black at 0.18, spacing 8. Sign in counts as step 1.

* **Step 2, Make your avatar** (shown only when the account has no avatar shape on the server and has not skipped on this phone): title "Make your avatar" (24), subtitle "It lives on your badge and reacts when someone you should meet is near. You can change it anytime.", then the live `AvatarPreview` (160 pt avatar on a `FlowingBackground(flow: 0.8)` rounded 16; tap cycles through all seven expressions), the shape grid (4 columns, spacing 10, each a white 14 radius tile with a 54 pt static avatar in the chosen color and its name, selected one outlined 2 pt black), and the color row (10 swatch circles 40 pt, selected outlined 3 pt, plus a system color well). Every pick sets the expression to excited for 1.2 s then back to happy. Pinned at the bottom: Continue (saves shape and color) and Skip for now. Default selection blob and `#FF6C6E`, or the account's current avatar.
* **Step 3, How do you want to set up?**: "Everything is optional. You can change it anytime." Two big choice cards with an icon button: "Text with your agent" (yellow, opens SMS with "Hi! Let's set up my badge.") and "Fill it in myself" (blue, jumps to the Profile tab). Skip for now at the bottom. It requests microphone and speech permission on appear. Choosing anything marks setup done (`didChooseSetup`).
* The tab bar waits until the profile loads (up to 4 s offline) so setup never flashes the tabs first.

### 7.4 Tabs

System tab bar (Liquid Glass, `.tabViewStyle(.tabBarOnly)`), always at the bottom, three tabs: **Badge** (`person.text.rectangle`), **People** (`person.2`), **Profile** (`person.crop.circle`). Tab changes play `tabSwitch`. California recording consent alerts attach to the tabs (and to the worn badge, since alerts cannot show under a full screen cover).

### 7.5 Badge tab and full screen worn mode

* Header "Badge" (34 semibold), "Demo data" caption when mocked, and a wear icon button (`arrow.up.left.and.arrow.down.right`).
* The live preview window (3.8). Ways in: pinch out past 1.15, swipe up past 70 pt or a predicted end beyond 220 pt up, or the wear button. Pulling down resists at one sixth. A detent cue fires when letting go would wear it. Dragging on the avatar squishes it instead (the preview's gesture is one combined magnify plus drag, not simultaneous with children).
* Status line under it (body, secondary ink): idle "Swipe up or pinch out to wear it. Your badge reacts when someone you should meet comes close."; match "NAME is nearby. Your avatar is taking on your shared color."; found "You found NAME! Say hi."; talking "You're talking with NAME." plus " Recording for your summary." while recording; connected "NAME is in your People. Say hi again!".
* **Worn**: `fullScreenCover` zooming out of the preview; the badge fills the screen ignoring safe areas, status bar and home indicator hidden, idle timer disabled (screen stays awake), orientation follows the space (wider than tall is landscape). Pinch in below 0.85 takes it off. Accessibility actions "Wear badge" and "Take off badge". Wear and take off cues play in the store's `isWorn` setter, so every path (gesture, hinge, system dismiss) sounds the same.

### 7.6 People: list, sidebar and detail

* `NavigationSplitView` (balanced). On a phone or folded Duo it collapses to a stack and tapping pushes the person; on iPad, landscape and the unfolded Duo the list stays on the left with the selected person beside it. Sidebar width min 280, ideal 330, max 400.
* List: live, newest first, searchable ("Search people", matches name or headline). Row: 46 pt static happy avatar, name (headline 17 semibold), a caption line of headline and company joined by " · " (or the first three tags), then the last summary (2 lines) or "Met in person" for unsaved people, and the time on the right. Empty: "No one yet" with "People you meet show up here, with a summary after you talk."
* Empty detail pane (wide only): `FlowingBackground(flow: 0.4)`, a 96 pt yellow (`#FFD55D`) happy blob (seed 7), "Pick someone to catch up" or "No one here yet" with explanatory text, on a white 0.9 card 28 padded, max width 480 (0.75 × 640).
* Person detail: `FlowingBackground(flow: 0.4)`, inline title with the name. Blocks: identity card (same component as the badge, scale 0.91, name 76, avatar room 112, min height 230, idle, layout photoText if they have a photo), About card (headline, red location pill, met or saved status line with an icon), Summary card (summary text, "You're talking now..." while ongoing, a spinner "Writing your summary", or a placeholder; topic chips at 13 pt without icons), Suggested follow up (blue block with a Share button "Copy or send"), Interests (yellow block), Timeline card (time column 70 pt wide). One column up to the readable width 640; two columns from a 760 pt wide pane (left: identity, about, follow up; right: summary, interests, timeline), max 1080. 20 pt spacing, 24 pt bottom content margin to clear the floating tab bar.

### 7.7 Profile

* `FlowingBackground(flow: 0.6)`, no navigation bar. Top bar: 38 pt static avatar, Region pill (a menu: "California: ask before recording" or "Elsewhere: record automatically", showing CA or Other on a yellow chip), a plus button to add a photo moment (then an alert asks for a caption), and a Settings icon button.
* Blocks: identity card (as in People, tap to edit, a palette icon button at the top left opens "Customize badge"), Interests (yellow, tag chips and moment cards, up to 30 moments, long press to remove, pencil to edit), "At this event" (blue, three fact tiles on cream: Looking for, I can help with, How to find me, "Not set yet" placeholders), "Your agent" card with a Text your agent button. An empty hint card appears when there are no interests and no moments.
* Columns: 1 below 540 pt; 2 from 540 (identity, event, agent | interests); 3 from 1000 (identity, agent | interests | event); max content width 1400.
* Customize badge sheet: live preview (180 pt), shape grid, color row, Badge layout segmented picker (Avatar, Photo and text, Photo; a hint if no photo), Photo picker (Choose, Change, Remove). Changes save immediately; picking a photo while on the avatar layout switches to photo and text.
* Edit profile sheet (Form): You (name, role, company or school, city), Interests (comma separated tags and hobbies), At this event (who you want to meet, what you can help with), How to find you. Save is disabled until the form holds the real profile.

### 7.8 Settings

Form on cream: Account (phone number, Text your agent); Recording (Record conversations, California mode, with a footer that transcription is on the phone); Feedback (Sounds toggle and Volume slider, Haptics toggle and Strength slider; releasing the volume slider plays a button press, releasing the strength slider plays the match chime haptic so you feel the new level; toggles play the toggle cue); Nearby (UWB) diagnostics with per peer distance, an Extended range toggle on supported hardware and Restart ranging; Backend picker; Sign out.

### 7.9 Wide layout rules recap

| Token | Value | Use |
|---|---|---|
| twoColumnWidth | 540 | Profile goes to 2 columns |
| threeColumnWidth | 1000 | Profile goes to 3 columns |
| maxContentWidth | 1400 | Profile cap |
| gridCardMinWidth | 300 | narrowest card in a people grid (defined, not used by the current views) |
| sidebarMin / Ideal / Max | 280 / 330 / 400 | People sidebar |
| readableCardWidth | 640 | Person detail single column cap |
| detailTwoColumnWidth | 760 | Person detail goes to 2 columns |
| detailMaxWidth | 1080 | Person detail cap |

Layouts follow the measured width (`onGeometryChange`), not device type, and the badge picks landscape whenever its space is wider than tall.

---

## 8. Tokens recap

### 8.1 Colors

| Token | Value |
|---|---|
| background (cream) | `#FEF3D4` |
| surface | white |
| surfaceMuted (chips, icon buttons, fields) | `#FEF3D4` |
| ink | `#2C2C2C` |
| inkSecondary | `#2C2C2C` at 0.62 |
| strongInk | black |
| red | `#FF6C6E` |
| yellow | `#FFEA82` |
| yellowStrong (primary buttons, default match color) | `#FFD55D` |
| purple | `#EB8FFF` |
| green | `#A9F48E` |
| blue | `#87D9FB` |
| plezi | `#509DF8` |
| accents (moment frames, cycled) | blue, purple, plezi, green, red, yellow |
| recordingDot | `#FF3B30` |
| avatar swatches | `#FF6C6E` `#FFEA82` `#EB8FFF` `#A9F48E` `#87D9FB` `#509DF8` `#3BB52D` `#45D0DD` `#F8CD4C` `#FAA752` |
| default avatar color | `#FF6C6E` |
| avatar ink / crescent / blush / tongue | `#1A1A1A` / `#111111` / `#FF6C9A` / `#FF8FA8` |
| background palette | section 2 |

### 8.2 Type

General Sans (Fontshare, ITF Free Font License; files are not committed, fetched by a script) with PostScript names `GeneralSans-Regular`, `-Medium`, `-Semibold`, `-Bold` (bold, heavy and black all map to Bold). Falls back to the system font at the same size and weight if missing. `Font.brand(size, weight)` scales with Dynamic Type; `Font.brandFixed` does not (badge display type).

| Token | Font |
|---|---|
| largeTitle | 34 semibold |
| title | 24 regular |
| headline | 17 semibold |
| body | 16 regular |
| caption | 12 regular |
| sectionTitle | 18 semibold |
| fieldLabel | 13 semibold |
| field title (LabeledField) | 14 semibold |
| primary button | 17 semibold |
| secondary button | 15 semibold |
| name lockup | first line bold, last line semibold at 0.64, gap −0.12 em, tracking −0.025 em, company 0.34 of the first line (max 26 × scale) medium |
| keywords | header 17 × scale medium, rows 42 × scale (portrait) or 40 × scale (landscape) semibold |
| tag chip | 16 regular (semibold when highlighted) |
| moment caption | 11 × scale semibold uppercase; date 11 × scale |

### 8.3 Radii, spacing, shadows

| Token | Value |
|---|---|
| cornerRadius (cards) | 16 |
| smallRadius | 12 (interests block uses 12 × scale × 1.3) |
| badgeCornerRadius | 40 (defined; the badge itself uses concentric corners with minimum 12 × scale) |
| primary button | radius 14, min height 52, full width, yellowStrong |
| secondary button | radius 10, padding 14 × 9, cream |
| icon button | 34 × 34, radius 8, cream, SF Symbol 15 bold |
| text field | padding 14, radius 14, cream |
| fact tile | padding 12, radius 18 |
| moment card | photo 92 × 112 radius 10, frame padding 8 radius 10 |
| tag chip | capsule, padding 0.85 × size by 0.55 × size, red sparkle icon at 0.75 size |
| spacing | 20 |
| screenPadding | 18 |
| card padding | 18 |
| button shadow | black 0.22, radius 0.75, y 1.5, on the shape only (never the label) |
| badge preview shadow | black 0.14, radius 20, y 10, white 6 pt border |

**Verbatim** (`DesignSystem/Theme.swift` 6 to 106, `Components.swift` button and chip styles, `Typography.swift`):

```swift
// DesignSystem/Theme.swift lines 6 to 106
struct Theme {
    // Surfaces
    var background = Color(hex: "#FEF3D4")      // cream
    var surface = Color.white
    var surfaceMuted = Color(hex: "#FEF3D4")    // chips and icon buttons
    var ink = Color(hex: "#2C2C2C")
    var inkSecondary = Color(hex: "#2C2C2C").opacity(0.62)
    var strongInk = Color.black

    // Palette
    var red = Color(hex: "#FF6C6E")
    var yellow = Color(hex: "#FFEA82")
    var yellowStrong = Color(hex: "#FFD55D")
    var purple = Color(hex: "#EB8FFF")
    var green = Color(hex: "#A9F48E")
    var blue = Color(hex: "#87D9FB")
    var plezi = Color(hex: "#509DF8")

    /// Colors cycled for photo frames and accents.
    var accents: [Color] { [blue, purple, plezi, green, red, yellow] }

    /// The flowing background (from the designer's blurred shapes).
    var backgroundPalette: [Color] = [
        "#9CD9FF", "#A5C3FB", "#EB8FFF", "#FAB2F7",
        "#FFEA82", "#F8CD4C", "#FAA752", "#FA9E96",
        "#FF6C6E", "#F7A8AB", "#CAFFCC", "#87D9FB",
        "#F8B2AE", "#FFEA82", "#A5C3FB", "#EB8FFF",
    ].map(Color.init(hex:))

    // Shape and spacing
    var cornerRadius: CGFloat = 16
    var smallRadius: CGFloat = 12
    var badgeCornerRadius: CGFloat = 40
    var spacing: CGFloat = 20
    var screenPadding: CGFloat = 18
    /// Wide screens (iPad, the unfolded Duo, landscape) lay pages out in
    /// columns: two from this width, three from the next, never wider than the cap.
    var twoColumnWidth: CGFloat = 540
    var threeColumnWidth: CGFloat = 1000
    var maxContentWidth: CGFloat = 1400
    /// Narrowest a card in a grid of people gets.
    var gridCardMinWidth: CGFloat = 300
    /// People sidebar beside a person's page (iPad, the unfolded Duo, landscape).
    var sidebarMinWidth: CGFloat = 280
    var sidebarIdealWidth: CGFloat = 330
    var sidebarMaxWidth: CGFloat = 400
    /// A person's page: one column of cards stays this narrow, two columns this wide at most.
    var readableCardWidth: CGFloat = 640
    var detailTwoColumnWidth: CGFloat = 760
    var detailMaxWidth: CGFloat = 1080

    // Type (General Sans, falls back to the system font if not bundled)
    var largeTitle = Font.brand(34, .semibold)
    var title = Font.brand(24)
    var headline = Font.brand(17, .semibold)
    var body = Font.brand(16)
    var caption = Font.brand(12)
    /// Every section and card title ("Interests", "At this event", "Your agent", ...).
    var sectionTitleSize: CGFloat = 18
    var sectionTitle: Font { .brand(sectionTitleSize, .semibold) }
    /// Small labels above a value ("Looking for", "I can help with").
    var fieldLabel = Font.brand(13, .semibold)

    /// The name on the identity card: first name biggest, the rest of the name
    /// a step down and pulled up close under it, both tracked a little tight.
    var nameLastRatio: CGFloat = 0.64
    /// Space between the two name lines, in first name ems (negative pulls them together).
    var nameLineGap: CGFloat = -0.12
    /// Letter spacing of the name, in ems.
    var nameTracking: CGFloat = -0.025
    /// Company under the name, relative to the first name.
    var nameCompanyRatio: CGFloat = 0.34
    var nameWeight: Font.Weight = .bold
    var nameLastWeight: Font.Weight = .semibold

    /// Avatar colors offered in setup and in the badge editor.
    var avatarSwatches: [String] = [
        "#FF6C6E", "#FFEA82", "#EB8FFF", "#A9F48E", "#87D9FB",
        "#509DF8", "#3BB52D", "#45D0DD", "#F8CD4C", "#FAA752",
    ]

    /// Buttons and pills sit close on their shadow: on the shape only, never the label.
    var shadowColor = Color.black.opacity(0.22)
    var shadowRadius: CGFloat = 0.75
    var shadowY: CGFloat = 1.5

    /// Both people's colors flowing over the badge background: this opacity
    /// when a match is first sensed (10 m), rising to the upper bound by 3 m.
    var matchWashOpacity: ClosedRange<Double> = 0.12...0.72
    /// How fast that two color blend drifts across the badge (radians per second).
    var pairWashSpeed: Double = 0.35
    /// How much of the match color the white identity card takes on at talking distance.
    var matchCardTint: Double = 0.22
    /// The live microphone meter in the recording pill on the badge screen.
    var recordingDot = Color(hex: "#FF3B30")

    /// How the badge itself is drawn (window and worn).
    var badgeStyle: any BadgeStyle = PlayfulBadgeStyle()

    static let playful = Theme()
}
```

```swift
// DesignSystem/Components.swift lines 59 to 191
/// A filled shape with the theme's tight drop shadow, for button backgrounds.
/// Put it in `.background` so the shadow stays off the label.
struct RaisedFill<S: Shape>: View {
    var shape: S
    var fill: Color
    @Environment(\.theme) private var theme

    var body: some View {
        shape.fill(fill)
            .shadow(color: theme.shadowColor, radius: theme.shadowRadius, y: theme.shadowY)
    }
}

/// Cream pill with a small icon, the designer's "Name Tag".
struct TagChip: View {
    var text: String
    var systemImage: String? = "sparkle"
    var size: CGFloat = 16
    var fill: Color?
    var highlighted = false
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.75, weight: .semibold))
                    .foregroundStyle(theme.red)
            }
            Text(text)
                .font(.brand(size, highlighted ? .semibold : .regular))
                .foregroundStyle(theme.strongInk)
                .lineLimit(1)
        }
        .padding(.horizontal, size * 0.85)
        .padding(.vertical, size * 0.55)
        .background(fill ?? theme.surfaceMuted, in: Capsule())
        .overlay(Capsule().strokeBorder(theme.ink.opacity(highlighted ? 0.9 : 0), lineWidth: 2))
    }
}

/// The designer's square cream icon button with a soft drop shadow.
struct IconButton: View {
    var systemImage: String
    var label: String
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(theme.strongInk)
                .frame(width: 34, height: 34)
                .background(RaisedFill(shape: RoundedRectangle(cornerRadius: 8), fill: theme.surfaceMuted))
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(label)
    }
}

/// Wraps an arbitrary label in the icon button look (for Menu and PhotosPicker).
struct IconButtonLabel: View {
    var systemImage: String
    @Environment(\.theme) private var theme

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(theme.strongInk)
            .frame(width: 34, height: 34)
            .background(RaisedFill(shape: RoundedRectangle(cornerRadius: 8), fill: theme.surfaceMuted))
    }
}

/// Main call to action: yellow pill, dark text, same drop shadow.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.brand(17, .semibold))
            .foregroundStyle(theme.strongInk)
            .frame(maxWidth: .infinity, minHeight: 52)
            // Shadow on the shape only, close under it (not on the label text)
            .background(RaisedFill(shape: RoundedRectangle(cornerRadius: 14), fill: theme.yellowStrong))
            .opacity(isEnabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.pressSpring, value: configuration.isPressed)
            .pressFeedback(configuration.isPressed)
    }
}

/// Secondary action: cream pill.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.theme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.brand(15, .semibold))
            .foregroundStyle(theme.strongInk)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(RaisedFill(shape: RoundedRectangle(cornerRadius: 10), fill: theme.surfaceMuted))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.pressSpring, value: configuration.isPressed)
            .pressFeedback(configuration.isPressed)
    }
}

struct PressScaleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.pressSpring, value: configuration.isPressed)
            .pressFeedback(configuration.isPressed)
    }
}

extension Animation {
    /// Quick in, with a small bounce on the way back out.
    static let pressSpring = Animation.spring(response: 0.22, dampingFraction: 0.6)
}

@MainActor
private extension View {
    /// Soft press sound and light tap the moment a button goes down.
    func pressFeedback(_ isPressed: Bool) -> some View {
        onChange(of: isPressed) { _, pressed in
            if pressed { Feedback.shared.play(.buttonPress) }
        }
    }
}
```

```swift
// DesignSystem/Typography.swift lines 7 to 34
enum BrandFont {
    static func name(for weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "GeneralSans-Bold"
        case .semibold: return "GeneralSans-Semibold"
        case .medium: return "GeneralSans-Medium"
        default: return "GeneralSans-Regular"
        }
    }

    static let isAvailable = UIFont(name: "GeneralSans-Regular", size: 12) != nil
}

extension Font {
    /// Brand font at a fixed size that still scales with Dynamic Type.
    static func brand(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        BrandFont.isAvailable
            ? .custom(BrandFont.name(for: weight), size: size)
            : .system(size: size, weight: weight)
    }

    /// Brand font that does not scale (badge display type sized to the screen).
    static func brandFixed(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        BrandFont.isAvailable
            ? .custom(BrandFont.name(for: weight), fixedSize: size)
            : .system(size: size, weight: weight)
    }
}
```
