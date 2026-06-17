name: WC2026 Auto-Sync Results

on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - run: npm install

      - run: node sync.js
        env:
          FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
