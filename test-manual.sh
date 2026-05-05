#!/bin/bash

# Build the bundle first
node build/background.js

# Run the test (uses fake device - will show green unless on real display)
node test-sw.mjs

# Copy output to a known location
if [ -f google-hello-world.webm ]; then
  echo "Recording saved to: $(pwd)/google-hello-world.webm"
  echo "Open with: open google-hello-world.webm"
  echo "Or drag to Chrome/VLC"
fi
