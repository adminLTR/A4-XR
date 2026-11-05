# A4 Design draft — Technique 2: Carry

Written before implementation.

## What it does

After the user selects a piece, they hold an on-screen **Llevar** button.
While the button is held, the selected object follows the intersection of
the phone’s forward ray with the table plane: moving the phone moves the
object (direct, isomorphic, like A2’s grab). Releasing the button parks
it. Rotation is **not** done with a two-finger twist. It uses on-screen
↺ / ↻ buttons, so translation and yaw are separate modes.

## Course concept

- **Isomorphic / direct mapping** (A2 grab, Class on input mappings): the
  phone is already a tracked 6-DoF window onto the room. Using that
  motion to carry the object avoids the extra mapping from a 2D finger
  path onto the 3D plane.
- **Separated DoF**: two-finger gestures on a phone couple drag and twist
  and the fingers cover the target (occlusion, Class 15 / AR perception).
  Putting yaw on buttons removes that coupling.

## Predicted trade-off

Carry should be **faster for translation**, especially larger moves,
because the user can walk the phone along the table instead of dragging
a finger that also hides the ghost.

The cost is **arm fatigue** (the phone must stay aimed at the table) and
**slower / more stepwise rotation**. I predict:

- lower `completion_time_s` than touch on trials with a large initial gap
- similar or slightly higher `yaw_error_deg` (discrete buttons)
- higher “How tired are your arms?” (1–5)
- fewer `wrong_selections` and fewer fat-finger `touch_count` events,
  because selection is a tap and motion is the phone, not a second
  gesture over the object

If the prediction is wrong, the likely reason is tracking drift while
the arm is moving, or the clutch (hold / release) adding extra time.
