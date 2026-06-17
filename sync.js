name: WC2026 Auto-Sync Results

on:
  schedule:
    - cron: "0 * * * *"   # top of every hour

  workflow_dispatch:
    inputs:
      reason:
        description: "Reason for manual sync"
        required: false
        default: "Manual trigger"

jobs:
  sync:
    name: Sync match results
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install dependencies
        run: npm install

      - name: Run sync
        env:
          FIREBASE_SERVICE_ACCOUNT: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
        run: node sync.js

      - name: Log completion
        if: always()
        run: echo "Sync completed at $(date -u)"
