# Wind Shift Detection

This document summarizes the current conceptual model for wind shift detection in Advanced Wind. It is intended as a basis for both implementation and user-facing documentation.

## Purpose

The plugin already estimates corrected true wind from apparent wind and vessel data. Wind shift detection should build on that by identifying changes in true wind direction that are meaningful to the sailor.

The aim is not to detect every fluctuation. The aim is to detect shifts that a sailor may want to react to.

## What Is A Wind Shift?

A wind shift is a meaningful change in the direction of the true wind.

More precisely:

- It is based on true wind, not raw apparent wind.
- It is a change in direction, not merely a change in wind speed.
- It is measured in a stable reference frame.
- It must exclude changes caused only by vessel motion, steering, heel, mast movement, or sensor artifacts.

In this plugin, the natural basis for wind shift detection is corrected true wind direction.

Internally, however, wind direction must be treated as a vector quantity rather than as a simple scalar angle.

## What Makes A Shift Meaningful?

Meaningful does not mean purely meteorological. Meaningful means meaningful to the sailor.

A meaningful wind shift is a true wind direction change that is large enough, credible enough, and persistent enough that the sailor may want to reconsider a sailing decision.

This makes wind shift detection objective dependent.

## Sailor Objective

Meaning depends on the sailor's goal, not on relative wind angle.

Examples:

- A racer may care about relatively small and short-lived shifts because they can create tactical advantage.
- A cruiser may care only about larger and more persistent shifts that justify a course change or sail-plan change.
- A passage sailor may care mainly about shifts large enough to affect routing, comfort, ETA, or whether a waypoint remains fetchable.

Point of sail is deliberately not part of the detection definition.

Reasons:

- A wind shift is a fact about the wind, not about the boat.
- The same real shift should be detected regardless of whether the boat is beating, reaching, or running.
- Point of sail can affect how the sailor interprets or reacts to the shift, but not whether the shift exists.

## Observable, Meaningful, And Actionable

It is useful to distinguish three levels:

- Observable shift: a real and credible change in true wind direction.
- Meaningful shift: an observable shift that matters to the sailor's current objective.
- Actionable shift: a meaningful shift for which the sailor should consider acting now.

This distinction matters because not every real shift requires an immediate response.

## Reference Direction

The reference model is fixed to one mode: recent mean wind direction.

This means:

- current wind is always compared to a rolling recent mean vector
- no latched reference modes are included for now (for example last tack or departure reference)

Sailor objective still matters, but it changes sensitivity and filter tuning, not the reference type.

## Shift Signal

Conceptually, the shift signal is the angular separation between:

- the current true wind direction vector
- the chosen reference wind vector

If the current wind vector is $\mathbf{w}_{current}(t)$ and the reference wind vector is $\mathbf{w}_{reference}(t)$, then the shift size is the signed angular difference derived from those vectors.

$$
s(t) = \operatorname{atan2}
\left(
\mathbf{w}_{reference} \times \mathbf{w}_{current},
\mathbf{w}_{reference} \cdot \mathbf{w}_{current}
\right)
$$

The sign of $s(t)$ indicates shift direction. The magnitude of $s(t)$ indicates shift size.

## Core Shift Properties

At this stage, a meaningful shift is defined by at least three properties.

### 1. Size

Size is the angular displacement from the reference vector.

This is the first and simplest property:

- Small random deviations are not meaningful.
- Larger deviations may become meaningful, depending on objective.

### 2. Duration

Duration answers:

How long has the shift already been in place?

Duration is backward-looking. It measures how established the current shift is.

Longer duration generally increases confidence that the shift is real and relevant.

### 3. Phase

Phase answers:

Where is the shift in its lifecycle?

Examples of phase:

- onset: the shift is building
- peak: the shift is near its maximum extent
- return: the shift is unwinding toward the reference
- settled: the wind appears to have stabilized at a new direction
- neutral: no meaningful shift is present

Phase matters because a sailor reacts differently to a growing shift than to a shift that is already returning.

## Can Phase Be Derived From The Derivative Of Size?

Largely yes.

If $s(t)$ is the shift size, then its derivative $\dot{s}(t)$ indicates whether the shift is growing, stable, or shrinking.

Interpretation:

- If $s \cdot \dot{s} > 0$, the shift is growing in its current direction.
- If $s \cdot \dot{s} < 0$, the shift is returning toward the reference.
- If $\dot{s} \approx 0$ while $|s|$ is large, the shift is either at a peak or settled.
- If both $|s|$ and $|\dot{s}|$ are small, the wind is neutral relative to the reference.

Derivative alone is not enough to distinguish peak from settled. Duration is also needed:

- short near-zero derivative at large size suggests peak
- sustained near-zero derivative at large size suggests settled

So phase can be treated as a function of size, derivative, and time spent in the current state.

## Relation To Oscillation Wavelength

Wind direction behaves like a time-varying signal containing structure at different timescales.

This matters because a rolling reference can hide the very oscillations it is supposed to help detect.

If the rolling-reference window is poorly matched to the wind's oscillation period, the reference may move with the oscillation and reduce the apparent shift to near zero.

Therefore:

- the reference timescale must be chosen with the target oscillation wavelength in mind
- different sailor objectives imply interest in different frequency bands

Examples:

- racers may care about minute-scale oscillations
- cruisers may care about broader directional changes over longer intervals
- passage sailors may care about long-period trends rather than short tactical oscillations

## Wind Direction As A Signal

It is useful to think of true wind direction as the result of multiple waveform-like components:

$$
\theta(t) = \theta_0 + A_1\sin(\omega_1 t + \phi_1) + A_2\sin(\omega_2 t + \phi_2) + \ldots + noise
$$

This is conceptually similar to Fourier analysis.

Interpretation:

- very low frequencies represent long-term trends
- medium frequencies represent tactical oscillations
- high frequencies represent short-term noise, wave effects, and other rapid disturbances

Under this model, sailor objective can be viewed as a choice of which part of the frequency spectrum matters.

## Technical Representation

Wind direction is circular data. It is not continuous when represented as a simple angle because $0^\circ$ and $360^\circ$ describe the same direction.

This creates problems for any logic based directly on scalar angle arithmetic.

Example:

- recent mean wind: $359^\circ$
- current wind: $1^\circ$

Naive subtraction gives a shift of $-358^\circ$, even though the real shift is only $2^\circ$.

For that reason, the detection logic must operate on wind vectors, not on raw direction angles.

### Vector Representation

A wind direction can be represented as a unit vector:

$$
\mathbf{w}(t) =
\begin{bmatrix}
\cos \theta(t) \\
\sin \theta(t)
\end{bmatrix}
$$

For wind shift detection, the preferred representation is directional only. Wind speed should not be allowed to dominate the directional average unless a later design decision explicitly chooses speed weighting.

### Why Vector Logic Is Required

Using vectors solves three core problems:

1. wraparound at $360^\circ / 0^\circ$
2. incorrect averaging of directions near wrap boundaries
3. unstable shift calculations caused by naive angle subtraction

This means:

- mean wind direction must be computed from averaged vector components
- current wind and reference wind should both be represented as filtered vectors
- shift size should be computed from vector comparison and only converted to degrees for reporting

### Mean Wind As A Mean Vector

Recent mean wind should not be interpreted as the arithmetic mean of angle values.

It should be interpreted as the filtered mean of wind vectors over time.

Only after that vector has been formed should it be converted back to a direction for display, if needed.

### Shift Size From Vector Geometry

Given a current wind vector $\mathbf{w}_c$ and a reference wind vector $\mathbf{w}_r$, the signed angular shift is computed from vector geometry:

$$
\Delta \theta = \operatorname{atan2}
\left(
x_r y_c - y_r x_c,
x_r x_c + y_r y_c
\right)
$$

This yields the signed smallest-angle deviation between the two directions and avoids wraparound errors.

### Filtering In Vector Space

Filtering should be applied to vector components, not to scalar angles.

That means:

- the fast filter produces the current wind vector
- the slow filter produces the recent-mean reference vector
- the shift signal is derived from the angular difference between those two filtered vectors

This preserves continuity and gives a mathematically sound basis for later calculations such as duration and derivative-based behavior.

## Filtering Implications

The input to wind shift detection should be Kalman-smoothed true wind, but not necessarily the same smoothed true wind already used elsewhere in the plugin.

Reason:

- the existing smoothing may be tuned for accurate live wind output
- shift detection may require different smoothing and reference timescales

So wind shift detection should be free to use separate filters tuned for its own purpose.

Conceptually, a useful model is:

- a fast-smoothed true wind vector representing current wind
- a slower-smoothed reference vector representing baseline wind
- an angular separation between them representing shift size
- optionally an additional intermediate smoothing layer to help infer the derivative of the shift signal robustly

This supports both size-based and phase-based interpretation without relying on noisy raw derivatives.

## What Should Not Count As A Wind Shift?

The following should not be treated as true wind shifts:

- apparent wind changes caused only by boat acceleration or deceleration
- changes caused only by heading changes
- changes caused only by heel, mast motion, or sensor alignment issues
- momentary sensor noise
- pure wind-speed changes without meaningful direction change

## Working Conceptual Model

At the current stage, wind shift detection for Advanced Wind can be summarized as follows:

1. Start from corrected true wind direction.
2. Convert that direction into a wind vector representation for internal processing.
3. Use recent mean wind vector as reference.
4. Compute shift size as signed angular separation from that reference vector.
5. Evaluate how long the shift has persisted.
6. Treat a shift as meaningful only when size, duration, and credibility are sufficient for the selected objective profile.

Phase remains deferred and is not required for the initial implementation.

## Current MVP Scope

The initial implementation scope is intentionally narrow:

- input is corrected true wind direction, using wind-shift-specific smoothing as needed
- internal logic is vector-based rather than angle-based
- reference is recent mean wind only
- objectives available to the user are racing, cruising, and passaging
- users can tune filter parameters for experimentation
- detection is based on shift size, duration, and credibility
- output is shown in the webapp only
- webapp presentation starts with two time series and intermediate statistics

The MVP does not attempt to classify full shift lifecycle phase and does not yet expose shift data through Signal K paths or REST endpoints.

## Future Extensions

The following items remain outside the initial scope but may be added later:

- phase detection and presentation
- additional statistics derived from the shift signal
- Signal K path exposure
- REST API exposure
- richer webapp views and interpretations
- alternative reference models, if later testing shows a need for them

## Open Questions For Implementation

The conceptual discussion has already resolved part of the implementation direction.

### Decisions already made

- Initial user-selectable objectives: racing, cruising, passaging.
- Reference model: recent mean wind only.
- Filter configuration: user-selectable filters and parameters to enable experimentation.
- Reference model remains fixed; users can tune filter parameters within the recent-mean approach.

### Deferred items (TBD)

- Phase representation is deferred for now and excluded from the first implementation scope.
- Signal K path and REST exposure for shifts is deferred; initial focus is webapp-only.
- Webapp presentation will start with two time series plus intermediate statistics and evolve iteratively.

## Summary

Wind shift detection in this plugin should be based on corrected true wind direction, not raw apparent wind and not boat-relative wind angle.

Internally, the detection logic should operate on filtered wind vectors and derive angular shift only from vector comparison.

Meaningful shifts are objective-dependent. The sailor's goal determines what counts as normal wind, what counts as a meaningful deviation, and how sensitive the detector should be to different timescales of variation.

The core conceptual quantities are:

- reference direction
- shift size
- duration
- credibility

Phase remains conceptually relevant but is deferred from the initial implementation scope.

Together, these form a sound basis for future implementation and documentation.