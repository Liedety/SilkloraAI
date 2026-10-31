#!/usr/bin/env bash
set -e

echo "=== SilkloraAI Android APK Build Pipeline ==="

export JAVA_HOME="/usr/lib/jvm/java-17-openjdk"
export ANDROID_HOME="/home/admin/Android/Sdk"
export ANDROID_SDK_ROOT="/home/admin/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "Using JAVA_HOME: $JAVA_HOME"
echo "Using ANDROID_HOME: $ANDROID_HOME"

# 1. Check or install SDK components
if [ -f "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo "Accepting Android licenses..."
    yes | sdkmanager --licenses > /dev/null 2>&1 || true

    echo "Ensuring platform-tools, platforms;android-34, build-tools;34.0.0 are installed..."
    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" || true
fi

# 2. Build Web Assets
echo "Building web bundle with Vite..."
npm run build

# 3. Capacitor Sync
echo "Syncing Capacitor Android..."
npx cap sync android

# 4. Compile APK with Gradle
echo "Building APK via Gradle assembleDebug..."
cd android
./gradlew assembleDebug --no-daemon

# 5. Locate and export APK
APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
DEST_APK="/home/admin/Downloads/silklora-ai.apk"
if [ -f "$APK_PATH" ]; then
    mkdir -p "/home/admin/Downloads"
    cp -f "$APK_PATH" "$DEST_APK"
    cp -f "$APK_PATH" ../silklora-ai.apk
    echo "=== SUCCESS! APK updated at: $DEST_APK ==="
    ls -lh "$DEST_APK"
else
    echo "ERROR: APK not found at $APK_PATH"
    exit 1
fi
