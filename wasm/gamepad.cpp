#include "moonlight_wasm.hpp"

#include <iostream>
#include <array>
#include <utility>
#include <sstream>
#include <chrono>
#include <thread>
#include <cmath>
#include <map>
#include <limits>
#include <algorithm>
#include <string>

#include <Limelight.h>
#include <emscripten/emscripten.h>

// Immutable per-stream calibration snapshot. No DOM/window access from the streaming thread.
namespace {
struct CalibrationSettings {
  bool enabled = false;
  int buttons[17];
  double centers[4] = {0, 0, 0, 0};
  double minimums[4] = {-1, -1, -1, -1};
  double maximums[4] = {1, 1, 1, 1};
  double deadzones[2] = {0.08, 0.08};
  bool invert[4] = {false, false, false, false};
  CalibrationSettings() { for (int i = 0; i < 17; ++i) buttons[i] = i; }
};
std::array<CalibrationSettings, 4> calibrations;
}

void ApplyJoystickCalibrationSettings(const std::string& serialized) {
  std::array<CalibrationSettings, 4> nextProfiles;
  std::istringstream in(serialized);
  for (int slot = 0; slot < 4; ++slot) {
  CalibrationSettings next;
  std::string token;
  auto read = [&](double& value) -> bool {
    if (!std::getline(in, token, ',')) return false;
    try { value = std::stod(token); return std::isfinite(value); }
    catch (...) { return false; }
  };
  double value = 0;
  if (!read(value)) { calibrations = nextProfiles; return; }
  next.enabled = (value == 1);
  for (int i=0;i<17;++i) {
    if (!read(value) || value < 0 || value > 31 || std::floor(value) != value) { calibrations = std::array<CalibrationSettings, 4>(); return; }
    next.buttons[i] = static_cast<int>(value);
  }
  for (double& center : next.centers) {
    if (!read(value) || value < -1 || value > 1) { calibrations = std::array<CalibrationSettings, 4>(); return; }
    center = value;
  }
  for (double& deadzone : next.deadzones) {
    if (!read(value) || value < 0 || value > 0.75) { calibrations = std::array<CalibrationSettings, 4>(); return; }
    deadzone = value;
  }
  for (bool& invert : next.invert) {
    if (!read(value)) { calibrations = std::array<CalibrationSettings, 4>(); return; }
    invert = (value == 1);
  }
  // Optional measured ranges (V4). V3 snapshots keep the original -1/+1 bounds.
  for (int i = 0; i < 4; ++i) {
    if (!read(value)) break;
    if (value < -1 || value > 1) { calibrations = std::array<CalibrationSettings, 4>(); return; }
    next.minimums[i] = value;
  }
  for (int i = 0; i < 4; ++i) {
    if (!read(value)) break;
    if (value < -1 || value > 1) { calibrations = std::array<CalibrationSettings, 4>(); return; }
    next.maximums[i] = value;
  }
  nextProfiles[slot] = next;
  }
  calibrations = nextProfiles;
}

static double CalibrateJoystickAxis(const CalibrationSettings& calibration, int index, double raw) {
  if (!calibration.enabled || index < 0 || index >= 4 || !std::isfinite(raw)) return raw;
  const double center = calibration.centers[index];
  double adjusted = raw - center;
  // Asymmetric normalization from observed hardware endpoints.
  // Ignore unreliable / degenerate ranges rather than amplifying noise.
  const double negativeTravel = center - calibration.minimums[index];
  const double positiveTravel = calibration.maximums[index] - center;
  const double divisor = adjusted < 0 ? negativeTravel : positiveTravel;
  adjusted = divisor >= 0.12 ? adjusted / divisor : 0.0;
  adjusted = std::max(-1.0, std::min(1.0, adjusted));
  const double dead = calibration.deadzones[index / 2];
  const double magnitude = std::abs(adjusted);
  adjusted = magnitude <= dead ? 0.0 : std::copysign((magnitude - dead) / (1 - dead), adjusted);
  return calibration.invert[index] ? -adjusted : adjusted;
}

// Bitmask for gamepad combo buttons to stop the streaming session
const short STOP_STREAM_BUTTONS = BACK_FLAG | PLAY_FLAG | LB_FLAG | RB_FLAG;

// Bitmask for gamepad combo buttons to toggle the performance stats overlay
const short PERF_STATS_BUTTONS = BACK_FLAG | LB_FLAG | RB_FLAG | X_FLAG;

// Flag for gamepad to track controller rumble state
bool rumbleFeedbackSwitch = false;

// Flags for gamepad to track mouse emulation state
bool mouseEmulationSwitch = false;
bool mouseEmulationActive = false;

// Flags for gamepad to track face buttons state
bool flipABfaceButtonsSwitch = false;
bool flipXYfaceButtonsSwitch = false;

// For explanation on ordering, see: https://www.w3.org/TR/gamepad/#remapping
// Enumeration for gamepad buttons
enum GamepadButton {
  A, B, X, Y,
  LeftBumper, RightBumper,
  LeftTrigger, RightTrigger,
  Back, Play,
  LeftStick, RightStick,
  Up, Down, Left, Right,
  Special,
  Count,
};

// For explanation on ordering, see: https://www.w3.org/TR/gamepad/#remapping
// Enumeration for gamepad axis
enum GamepadAxis {
  LeftX = 0,
  LeftY = 1,
  RightX = 2,
  RightY = 3,
};

// Function to create a mask for active gamepads
static short GetActiveGamepadMask(int numGamepads) {
  short result = 0;
  
  for (int i = 0; i < numGamepads; ++i) {
    result |= (1 << i);
  }
  
  return result;
}

// Function to map gamepad buttons to flags
static short GetButtonFlags(const EmscriptenGamepadEvent& gamepad, int gamepadID, const CalibrationSettings& calibration) {
  // Triggers are considered analog buttons in the "Emscripten API", however they need
  // to be passed in separate arguments for "Limelight" (it even lacks flags for them).

  const int* buttonMasks = nullptr;
  int buttonMasksSize = 0;

  // Define button mapping with A/B and X/Y swapped
  static const int buttonMasksABXY[] = {
    B_FLAG, A_FLAG, Y_FLAG, X_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };
  // Define button mapping with A/B swapped
  static const int buttonMasksAB[] = {
    B_FLAG, A_FLAG, X_FLAG, Y_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };
  // Define button mapping with X/Y swapped
  static const int buttonMasksXY[] = {
    A_FLAG, B_FLAG, Y_FLAG, X_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };
  // Define default button mapping
  static const int buttonMasksDefault[] = {
    A_FLAG, B_FLAG, X_FLAG, Y_FLAG,
    LB_FLAG, RB_FLAG,
    0 /* LT_FLAG */, 0 /* RT_FLAG */,
    BACK_FLAG, PLAY_FLAG,
    LS_CLK_FLAG, RS_CLK_FLAG,
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG,
    SPECIAL_FLAG,
  };

  // Check if the A/B or X/Y face buttons switches are checked
  if (flipABfaceButtonsSwitch && flipXYfaceButtonsSwitch) {
    // Swap both A/B and X/Y buttons
    buttonMasks = buttonMasksABXY;
    buttonMasksSize = sizeof(buttonMasksABXY) / sizeof(buttonMasksABXY[0]);
  } else if (flipABfaceButtonsSwitch) { // Check if the A/B face buttons switch is checked
    // Swap A and B buttons
    buttonMasks = buttonMasksAB;
    buttonMasksSize = sizeof(buttonMasksAB) / sizeof(buttonMasksAB[0]);
  } else if (flipXYfaceButtonsSwitch) { // Check if the X/Y face buttons switch is checked
    // Swap X and Y buttons
    buttonMasks = buttonMasksXY;
    buttonMasksSize = sizeof(buttonMasksXY) / sizeof(buttonMasksXY[0]);
  } else {
    // Default buttons layout
    buttonMasks = buttonMasksDefault;
    buttonMasksSize = sizeof(buttonMasksDefault) / sizeof(buttonMasksDefault[0]);
  }

  short result = 0;
  
  for (int i = 0; i < buttonMasksSize; ++i) {
    // Mapping is target button -> physical source button, configured in Joystick Calibration.
    const int source = calibration.enabled ? calibration.buttons[i] : i;
    if (source >= 0 && source < gamepad.numButtons && gamepad.digitalButton[source] == EM_TRUE) {
      result |= buttonMasks[i];
    }
  }

  return result;
}

// Function to handle the gamepad input state
void MoonlightInstance::HandleGamepadInputState(bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons) {
  rumbleFeedbackSwitch = rumbleFeedback;
  mouseEmulationSwitch = mouseEmulation;
  flipABfaceButtonsSwitch = flipABfaceButtons;
  flipXYfaceButtonsSwitch = flipXYfaceButtons;
}

// Function to poll gamepad input
void MoonlightInstance::PollGamepads() {
  if (emscripten_sample_gamepad_data() != EMSCRIPTEN_RESULT_SUCCESS) {
    std::cerr << "Sample gamepad data failed!\n";
    return;
  }

  const auto numGamepads = emscripten_get_num_gamepads();
  if (numGamepads == EMSCRIPTEN_RESULT_NOT_SUPPORTED) {
    std::cerr << "Get num gamepads failed!\n";
    return;
  }

  // Create a mask for active gamepads
  const auto activeGamepadMask = GetActiveGamepadMask(numGamepads);

  // Prevent repeated trigger while the button combo is held down
  static std::map<int, bool> comboTriggered;

  // Track valid gamepads that had a non-zero timestamp at least once
  static bool isRealGamepad[32] = { false };

  // Iterate through connected gamepads and process their input
  for (int gamepadID = 0; gamepadID < numGamepads; ++gamepadID) {
    emscripten_sample_gamepad_data();
    EmscriptenGamepadEvent gamepad;
    // See logic in getConnectedGamepadMask() (utils.js)
    // These must stay in sync!

    const auto result = emscripten_get_gamepad_status(gamepadID, &gamepad);
    if (result != EMSCRIPTEN_RESULT_SUCCESS || !gamepad.connected) {
      // Not connected
      if (gamepadID < 32) {
        isRealGamepad[gamepadID] = false;
      }
      continue;
    }

    if (gamepadID < 32 && gamepad.timestamp != 0) {
      isRealGamepad[gamepadID] = true;
    }

    if (gamepad.timestamp == 0 && (gamepadID >= 32 || !isRealGamepad[gamepadID])) {
      // On some platforms, Tizen returns "connected" gamepads that really 
      // aren't, so timestamp stays at zero. To work around this, we'll only
      // count gamepads that have a non-zero timestamp in our controller index.
      continue;
    }

    // Process input for active gamepad
    const CalibrationSettings& calibration = calibrations[std::min(3, std::max(0, gamepadID))];
    const auto buttonFlags = GetButtonFlags(gamepad, gamepadID, calibration);
    const int ltSource = calibration.enabled ? calibration.buttons[6] : 6;
    const int rtSource = calibration.enabled ? calibration.buttons[7] : 7;
    const auto leftTrigger = (ltSource >= 0 && ltSource < gamepad.numButtons ? gamepad.analogButton[ltSource] : 0.0)
      * std::numeric_limits<unsigned char>::max();
    const auto rightTrigger = (rtSource >= 0 && rtSource < gamepad.numButtons ? gamepad.analogButton[rtSource] : 0.0)
      * std::numeric_limits<unsigned char>::max();
    const auto calibratedAxis = [&](int axis) -> double {
      double raw = axis < gamepad.numAxes ? gamepad.axis[axis] : 0.0;
      return CalibrateJoystickAxis(calibration, axis, raw);
    };
    const auto leftStickX = calibratedAxis(GamepadAxis::LeftX) * std::numeric_limits<short>::max();
    const auto leftStickY = -calibratedAxis(GamepadAxis::LeftY) * std::numeric_limits<short>::max();
    const auto rightStickX = calibratedAxis(GamepadAxis::RightX) * std::numeric_limits<short>::max();
    const auto rightStickY = -calibratedAxis(GamepadAxis::RightY) * std::numeric_limits<short>::max();

    // Check if the current button flags match the defined button combination on the gamepad
    if (buttonFlags == STOP_STREAM_BUTTONS) {
      // Terminate the connection
      stopStream();
      return;
    } else if (buttonFlags == PERF_STATS_BUTTONS) {
      if (!comboTriggered[gamepadID]) {
        // Toggle performance stats overlay
        toggleStats();
        // Mark combo as triggered until buttons are released
        comboTriggered[gamepadID] = true;
      }
    } else {
      // Reset when buttons are released
      comboTriggered[gamepadID] = false;
    }

    // Check if the mouse emulation switch is checked
    if (mouseEmulationSwitch) {
      static std::map<int, std::chrono::time_point<std::chrono::steady_clock>> activatePressTimes;
      // Toggle mouse emulation on and off based on how long the PLAY/START button is pressed
      if (buttonFlags & PLAY_FLAG) {
        if (activatePressTimes.find(gamepadID) == activatePressTimes.end()) {
          activatePressTimes[gamepadID] = std::chrono::steady_clock::now();
        }
        auto currentTime = std::chrono::steady_clock::now();
        // Calculate the duration in milliseconds since the PLAY/START button was pressed
        auto durationTime = std::chrono::duration_cast<std::chrono::milliseconds>(currentTime - activatePressTimes[gamepadID]).count();
        // If the button has been pressed for at least 1000 milliseconds (1 second)
        if (durationTime >= 1000) {
          // Toggle mouse emulation state
          if (!mouseEmulationActive) {
            // Activate mouse emulation and notify the user
            mouseEmulationActive = true;
            PostToJs(std::string("mouseEmulationOn"));
          } else {
            // Deactivate mouse emulation and notify the user
            mouseEmulationActive = false;
            PostToJs(std::string("mouseEmulationOff"));
          }
          // Reset the PLAY/START press time to the current time after toggling
          activatePressTimes[gamepadID] = std::chrono::steady_clock::now();
        }
      } else {
        // If the PLAY/START button is not pressed, reset PLAY/START press time to the current time
        activatePressTimes[gamepadID] = std::chrono::steady_clock::now();
      }
    } else {
      // Deactivate mouse emulation if the mouse emulation switch is unchecked
      mouseEmulationActive = false;
    }

    // If mouse emulation is active, then send mouse input to the desired handler (acts as a mouse)
    if (mouseEmulationActive) {
      // Left Stick values are mapped to horizontal and vertical mouse movements
      const float baseMouseSpeed = 10.0f;
      const float leftStickMagnitude = std::sqrt(leftStickX * leftStickX + leftStickY * leftStickY) / std::numeric_limits<short>::max();
      const float mouseSpeed = baseMouseSpeed * leftStickMagnitude;
      const float mouseXDelta = static_cast<float>(leftStickX) / std::numeric_limits<short>::max() * mouseSpeed;
      const float mouseYDelta = -static_cast<float>(leftStickY) / std::numeric_limits<short>::max() * mouseSpeed;
      
      // Send a mouse move event with the specified delta values for both horizontal (X-axis) and vertical (Y-axis) coordinates
      LiSendMouseMoveEvent(static_cast<int>(mouseXDelta), static_cast<int>(mouseYDelta));

      // Right Stick values are mapped to horizontal and vertical mouse scrolls
      const float baseScrollSpeed = 1.0f;
      const float rightStickMagnitude = std::sqrt(rightStickX * rightStickX + rightStickY * rightStickY) / std::numeric_limits<short>::max();
      const float scrollSpeed = baseScrollSpeed * rightStickMagnitude;
      const float scrollXDelta = static_cast<float>(rightStickX) / std::numeric_limits<short>::max() * scrollSpeed;
      const float scrollYDelta = static_cast<float>(rightStickY) / std::numeric_limits<short>::max() * scrollSpeed;
      
      // Send mouse scroll events with the specified delta values for both horizontal (X-axis) and vertical (Y-axis) coordinates
      LiSendHScrollEvent(static_cast<int>(scrollXDelta));
      LiSendScrollEvent(static_cast<int>(scrollYDelta));

      // Face Buttons values are mapped to control mouse buttons
      if (buttonFlags & (A_FLAG | LB_FLAG)) {
        // Send a mouse button press event for the left button
        LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, BUTTON_LEFT);
      } else {
        // Send a mouse button release event for the left button
        LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, BUTTON_LEFT);
      }
      if (buttonFlags & (X_FLAG | Y_FLAG)) {
        // Send a mouse button press event for the Middle button
        LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, BUTTON_MIDDLE);
      } else {
        // Send a mouse button release event for the Middle button
        LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, BUTTON_MIDDLE);
      }
      if (buttonFlags & (B_FLAG | RB_FLAG)) {
        // Send a mouse button press event for the Right button
        LiSendMouseButtonEvent(BUTTON_ACTION_PRESS, BUTTON_RIGHT);
      } else {
        // Send a mouse button release event for the Right button
        LiSendMouseButtonEvent(BUTTON_ACTION_RELEASE, BUTTON_RIGHT);
      }
    } else {
      // If mouse emulation is inactive, then send gamepad input to the desired handler (acts as a gamepad)
      LiSendMultiControllerEvent(
        gamepadID, activeGamepadMask, buttonFlags, leftTrigger,
        rightTrigger, leftStickX, leftStickY, rightStickX, rightStickY);
    }
  }
}

// Function to send controller rumble feedback for gamepad
void MoonlightInstance::ClControllerRumble(unsigned short controllerNumber, unsigned short lowFreqMotor, unsigned short highFreqMotor) {
  const float weakMagnitude = static_cast<float>(highFreqMotor) / static_cast<float>(UINT16_MAX);
  const float strongMagnitude = static_cast<float>(lowFreqMotor) / static_cast<float>(UINT16_MAX);
  
  // Check if the rumble feedback switch is checked
  if (rumbleFeedbackSwitch) {
    std::ostringstream ss;
    ss << controllerNumber << "," << weakMagnitude << "," << strongMagnitude;
    PostToJs(std::string("controllerRumble: ") + ss.str());
  }
}
