# ZOSI Monitor

A simple, robust desktop monitoring application for 4 IP cameras.

## Quick Start Guide: Getting Everything Working

### 1. Enable Remote Viewing (Global Access)
To view your cameras from anywhere for free:
- **Download Tailscale** on your PC and your Android phone.
- **Login** with the same account.
- **Access**: Use the camera's Tailscale IP address in the ZOSIView settings. No router configuration needed!

### 2. Enable Auto-Updates (GitHub)
To get the app to update itself automatically:
- **Update package.json**: Change `YOUR_GITHUB_USERNAME` to your real GitHub username.
- **Initialize Git**:
  ```bash
  git init
  git add .
  git commit -m "Initial commit"
  git remote add origin https://github.com/YOUR_GITHUB_USERNAME/ZOSIView.git
  git push -u origin main
  ```
- **Create a Release**: When you want to push an update, change the version in `package.json` (e.g., to `1.0.1`), build the app, and upload it to a "New Release" on GitHub.

### 3. Mobile (Android)
The core logic is already ported to `mobile/CameraLogic.js`. To start the mobile app:
- **Install React Native CLI**: `npm install -g react-native-cli`
- **Initialize Mobile Project**: Run `react-native init ZOSIMobile` inside the `mobile/` folder.
- **Import Logic**: Use `CameraLogic.js` in your mobile views to handle camera connections.

## Features
- **Grid View:** Displays 4 camera feeds in a 2x2 grid.
- **Dynamic Networking:** Automatically scans for active camera hosts and handles IP changes.
- **Configurable:** Edit refresh interval, candidate hosts, and camera URLs directly in the UI.
- **Robust:** Prevents display sleep, handles network errors gracefully, and runs as a single instance.
- **Secure:** Sandboxed environment with strict Content Security Policy.

## Requirements
- Node.js (v14 or later)
- npm (Node Package Manager)

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

Settings are managed within the application. Press `S` or use the settings button to open the configuration panel.

- **Refresh Interval:** How often to update the camera snapshots (in seconds).
- **Candidate Hosts:** List of IP addresses to scan if the connection is lost.
- **Camera URLs:** The snapshot URL for each camera (e.g., `http://10.1.1.189/cgi-bin/snapshot.cgi?chn=0&u=admin&p=pass`).

## Usage

- **Start:** `npm start`
- **Fullscreen:** Click on any camera to toggle fullscreen mode.
- **Settings:** Press `S` to open settings.
- **Debug Info:** Press `=` to toggle debug overlay.
- **Reload:** Use `View > Reload` or `Cmd+R` (macOS) / `Ctrl+R` (Windows).

## Remote Viewing (Anywhere Access)

To view your cameras from anywhere in the world for free, use **Tailscale**:

1.  **Install Tailscale**: Download and install Tailscale on the PC running ZOSIView and on your mobile device (Android).
2.  **Login**: Sign in with the same account on both devices.
3.  **Access**: Once connected, use the "Tailscale IP" of your camera host in the ZOSIView settings. This creates a secure, private tunnel to your home network without any router configuration.

## Auto-Updates (Desktop)

ZOSIView now includes an automatic update system via GitHub:

1.  **Host on GitHub**: Push this repository to GitHub.
2.  **Releases**: When you create a new "Release" on GitHub and upload the build artifacts, the app will automatically detect, download, and install the update on the next restart.
3.  **Configuration**: Ensure the `publish` section in `package.json` matches your GitHub username and repository name.

## Mobile Version (Android)

A mobile version for Android is currently under development in the `mobile/` directory using React Native. 

- **Distribution**: The mobile app will be distributed as a free APK file via GitHub Releases.
- **Updates**: The mobile app will check for newer APK versions on GitHub to prompt for updates.

## Building Executables

### macOS
To build a standalone `.app` for macOS:
```bash
npm run package:mac
```
The output will be in the `ZOSIView-darwin-x64` directory.

### Windows
To build a standalone `.exe` for Windows:
```bash
npm run package:win
```
The output will be in the `ZOSIView-win32-x64` directory.

## License
ISC
