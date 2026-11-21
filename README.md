put it in the library and use the calls

USE.init()
 * Initializes the AudioContext, master gain, compressor, and shared noise buffer.
USE.play(name, options)
 * Plays a registered preset by name.
 * Options object can include: volume, pitch, pan (-1 to 1), pitchJitter, volumeJitter, and id.
 * Returns the unique sound instance ID.
USE.stop(id)
 * Gracefully stops a specific active sound instance by its ID with a fade-out.
USE.stopAll()
 * Stops all currently active sounds.
USE.registerPreset(name, preset)
 * Registers a new custom sound preset.
USE.setMasterVolume(value)
 * Sets the global master volume (clamped between 0 and 1).
USE.setMaxVoices(n)
 * Sets the maximum concurrent voice limit (default is 48).
USE.getPresets()
 * Returns an array of strings with the names of all registered presets.
USE.context
 * Getter property exposing the raw underlying Web Audio AudioContext.
USE.version
 * Getter property returning the engine version string ("0.2.1").
 * 
