#!/usr/bin/env bash
set -e
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
npm install
npm install --prefix frontend
echo "Setup done." 