#!/bin/bash

QUALITY_LEVELS=(50 80)

for file in *.png; do
    for quality in "${QUALITY_LEVELS[@]}"; do
        new_file="${file%.jpg}_${quality}.jpg"
        /opt/mozjpeg/bin/cjpeg -quality "$quality" "$file" > "$new_file"
    done
done