#!/usr/bin/env bash
# Builds the sound variants in src/audio/sfx from Kenney's CC0 audio packs (kenney.nl/assets, category Audio).
# Usage: tools/sfx.sh <dir with the packs unzipped, one folder per pack: impact-sounds, interface-sounds, ...>
# Each line below: slot, variant name, pack/file, target peak in dBFS (the slot's loudness).
# Every file is trimmed of leading and trailing silence, made mono and normalized to its peak, then encoded as AAC in m4a (very short mp3s fail format probing).
set -euo pipefail

SRC=${1:?usage: tools/sfx.sh <kenney packs dir>}
OUT=$(cd "$(dirname "$0")/.." && pwd)/src/audio/sfx
MAX_SECONDS=4

PICKS=$(cat <<'EOF'
button click interface-sounds/click_001.ogg -10
button click-soft interface-sounds/click_002.ogg -10
button select interface-sounds/select_001.ogg -10
button select-2 interface-sounds/select_002.ogg -10
button toggle interface-sounds/toggle_001.ogg -10
button toggle-2 interface-sounds/toggle_002.ogg -10
button tap ui-audio/click1.ogg -10
button tap-2 ui-audio/click3.ogg -10
button mouse ui-audio/mouseclick1.ogg -10
button pluck interface-sounds/pluck_001.ogg -10
light pluck interface-sounds/pluck_001.ogg -9
light pluck-2 interface-sounds/pluck_002.ogg -9
light select interface-sounds/select_003.ogg -9
light rise interface-sounds/maximize_003.ogg -9
light glass interface-sounds/glass_002.ogg -9
light confirm interface-sounds/confirmation_001.ogg -9
light zap digital-audio/phaserUp4.ogg -12
light power digital-audio/powerUp5.ogg -12
light tick interface-sounds/tick_004.ogg -9
swap card-slide casino-audio/card-slide-1.ogg -9
swap card-slide-2 casino-audio/card-slide-4.ogg -9
swap card-place casino-audio/card-place-2.ogg -9
swap chip-stack casino-audio/chips-stack-2.ogg -9
swap chip-lay casino-audio/chip-lay-1.ogg -9
swap carpet impact-sounds/footstep_carpet_000.ogg -8
swap soft impact-sounds/impactSoft_medium_001.ogg -8
swap drop interface-sounds/drop_001.ogg -9
swap scratch interface-sounds/scratch_001.ogg -9
swap rollover ui-audio/rollover4.ogg -9
swap-fail error interface-sounds/error_001.ogg -9
swap-fail error-2 interface-sounds/error_004.ogg -9
swap-fail error-3 interface-sounds/error_008.ogg -9
swap-fail back interface-sounds/back_001.ogg -9
swap-fail close interface-sounds/close_001.ogg -9
swap-fail minimize interface-sounds/minimize_007.ogg -9
swap-fail thud impact-sounds/impactSoft_medium_000.ogg -8
swap-fail wood impact-sounds/impactWood_light_000.ogg -9
swap-fail book rpg-audio/bookClose.ogg -9
swap-fail card-shove casino-audio/card-shove-1.ogg -9
match chips casino-audio/chips-collide-1.ogg -6
match chips-2 casino-audio/chips-stack-1.ogg -6
match chip-lay casino-audio/chip-lay-2.ogg -6
match glass interface-sounds/glass_002.ogg -6
match glass-2 interface-sounds/glass_005.ogg -6
match pluck interface-sounds/pluck_002.ogg -6
match drop interface-sounds/drop_002.ogg -6
match glass-tap impact-sounds/impactGlass_light_000.ogg -6
match tin impact-sounds/impactTin_medium_000.ogg -7
match coins rpg-audio/handleCoins2.ogg -6
create rise interface-sounds/maximize_001.ogg -5
create rise-2 interface-sounds/maximize_004.ogg -5
create confirm interface-sounds/confirmation_001.ogg -5
create power digital-audio/powerUp2.ogg -9
create power-2 digital-audio/powerUp5.ogg -9
create zap digital-audio/phaserUp4.ogg -9
create bell impact-sounds/impactBell_heavy_004.ogg -6
create pep digital-audio/pepSound3.ogg -9
create glass interface-sounds/glass_001.ogg -5
create question interface-sounds/question_002.ogg -5
transform power digital-audio/powerUp7.ogg -8
transform rise interface-sounds/maximize_005.ogg -5
transform confirm interface-sounds/confirmation_002.ogg -5
transform zap digital-audio/phaserUp1.ogg -8
transform three-tone digital-audio/threeTone1.ogg -8
transform bell impact-sounds/impactBell_heavy_003.ogg -6
transform coins rpg-audio/handleCoins.ogg -5
transform chips casino-audio/chips-handle-1.ogg -5
last-chance question interface-sounds/question_001.ogg -4
last-chance confirm interface-sounds/confirmation_004.ogg -4
last-chance power digital-audio/powerUp3.ogg -8
last-chance zap-up digital-audio/zapThreeToneUp.ogg -8
last-chance three-tone digital-audio/threeTone2.ogg -8
last-chance bell impact-sounds/impactBell_heavy_002.ogg -5
last-chance low-tone digital-audio/lowThreeTone.ogg -8
last-chance two-tone digital-audio/twoTone1.ogg -8
line knife rpg-audio/knifeSlice.ogg -4
line knife-2 rpg-audio/knifeSlice2.ogg -4
line draw-knife rpg-audio/drawKnife1.ogg -4
line draw-knife-2 rpg-audio/drawKnife2.ogg -4
line laser digital-audio/laser4.ogg -9
line zap digital-audio/phaserUp3.ogg -9
line card-fan casino-audio/card-fan-1.ogg -4
line cloth rpg-audio/cloth1.ogg -4
line zap-2 digital-audio/zap1.ogg -9
bomb punch impact-sounds/impactPunch_heavy_000.ogg -2
bomb punch-2 impact-sounds/impactPunch_heavy_002.ogg -2
bomb mining impact-sounds/impactMining_000.ogg -2
bomb mining-2 impact-sounds/impactMining_003.ogg -2
bomb soft-heavy impact-sounds/impactSoft_heavy_000.ogg -2
bomb plate impact-sounds/impactPlate_heavy_000.ogg -3
bomb metal impact-sounds/impactMetal_heavy_001.ogg -3
bomb door rpg-audio/doorClose_1.ogg -2
bomb space-trash digital-audio/spaceTrash1.ogg -6
bomb low-down digital-audio/lowDown.ogg -6
prism bell impact-sounds/impactBell_heavy_000.ogg -3
prism bell-2 impact-sounds/impactBell_heavy_001.ogg -3
prism glass interface-sounds/glass_004.ogg -3
prism glass-ring impact-sounds/impactGlass_medium_000.ogg -3
prism pot rpg-audio/metalPot1.ogg -3
prism power digital-audio/powerUp1.ogg -7
prism power-2 digital-audio/powerUp12.ogg -7
prism zap-up digital-audio/zapThreeToneUp.ogg -7
prism chime interface-sounds/select_006.ogg -3
prism three-tone digital-audio/threeTone1.ogg -7
falling-star zap digital-audio/phaserUp2.ogg -9
falling-star zap-2 digital-audio/phaserUp5.ogg -9
falling-star jump digital-audio/phaseJump1.ogg -9
falling-star pep digital-audio/pepSound1.ogg -9
falling-star power digital-audio/powerUp9.ogg -9
falling-star laser digital-audio/laser9.ogg -10
falling-star high-up digital-audio/highUp.ogg -9
falling-star glass interface-sounds/glass_003.ogg -6
falling-star rise interface-sounds/maximize_008.ogg -6
ice glass-light impact-sounds/impactGlass_light_000.ogg -6
ice glass-light-2 impact-sounds/impactGlass_light_002.ogg -6
ice glass-heavy impact-sounds/impactGlass_heavy_003.ogg -6
ice glass-heavy-2 impact-sounds/impactGlass_heavy_000.ogg -6
ice glass-medium impact-sounds/impactGlass_medium_001.ogg -6
ice ui-glass interface-sounds/glass_002.ogg -6
ice ui-glass-2 interface-sounds/glass_005.ogg -6
ice ui-glass-3 interface-sounds/glass_006.ogg -6
ice snow impact-sounds/footstep_snow_000.ogg -6
ice tin impact-sounds/impactTin_medium_002.ogg -7
crate wood-light impact-sounds/impactWood_light_000.ogg -5
crate wood-medium impact-sounds/impactWood_medium_000.ogg -5
crate wood-heavy impact-sounds/impactWood_heavy_000.ogg -5
crate plank impact-sounds/impactPlank_medium_000.ogg -5
crate wood-step impact-sounds/footstep_wood_000.ogg -5
crate book rpg-audio/bookPlace1.ogg -5
crate chop rpg-audio/chop.ogg -5
crate creak rpg-audio/creak3.ogg -5
crate leather rpg-audio/dropLeather.ogg -5
crate door rpg-audio/doorClose_4.ogg -5
chain metal-light impact-sounds/impactMetal_light_000.ogg -7
chain metal-light-2 impact-sounds/impactMetal_light_002.ogg -7
chain metal-medium impact-sounds/impactMetal_medium_000.ogg -7
chain metal-heavy impact-sounds/impactMetal_heavy_000.ogg -7
chain latch rpg-audio/metalLatch.ogg -7
chain click rpg-audio/metalClick.ogg -7
chain belt rpg-audio/beltHandle1.ogg -7
chain coins rpg-audio/handleCoins2.ogg -7
chain tin impact-sounds/impactTin_medium_001.ogg -7
chain plate impact-sounds/impactPlate_light_002.ogg -7
shuffle card-fan casino-audio/card-fan-1.ogg -6
shuffle card-fan-2 casino-audio/card-fan-2.ogg -6
shuffle dice-shake casino-audio/dice-shake-1.ogg -6
shuffle chips casino-audio/chips-handle-5.ogg -6
shuffle chips-2 casino-audio/chips-handle-1.ogg -6
shuffle cloth rpg-audio/cloth1.ogg -6
shuffle belt rpg-audio/clothBelt.ogg -6
shuffle pack-open casino-audio/cards-pack-open-1.ogg -6
shuffle book-flip rpg-audio/bookFlip1.ogg -6
shuffle card-shuffle casino-audio/card-shuffle.ogg -6
star bell impact-sounds/impactBell_heavy_004.ogg -5
star glass interface-sounds/glass_001.ogg -5
star confirm interface-sounds/confirmation_001.ogg -5
star pluck interface-sounds/pluck_002.ogg -5
star chips casino-audio/chips-stack-3.ogg -5
star power digital-audio/powerUp6.ogg -9
star pep digital-audio/pepSound2.ogg -9
star glass-tap impact-sounds/impactGlass_light_001.ogg -5
star bong interface-sounds/bong_001.ogg -5
star rise interface-sounds/maximize_006.ogg -5
win steel music-jingles/jingles_STEEL00.ogg -3
win steel-2 music-jingles/jingles_STEEL04.ogg -3
win pizzicato music-jingles/jingles_PIZZI00.ogg -3
win pizzicato-2 music-jingles/jingles_PIZZI04.ogg -3
win sax music-jingles/jingles_SAX00.ogg -3
win hit music-jingles/jingles_HIT00.ogg -3
win hit-2 music-jingles/jingles_HIT04.ogg -3
win nes music-jingles/jingles_NES00.ogg -6
win nes-2 music-jingles/jingles_NES04.ogg -6
win confirm interface-sounds/confirmation_002.ogg -3
lose steel music-jingles/jingles_STEEL16.ogg -4
lose steel-2 music-jingles/jingles_STEEL10.ogg -4
lose pizzicato music-jingles/jingles_PIZZI16.ogg -4
lose pizzicato-2 music-jingles/jingles_PIZZI10.ogg -4
lose sax music-jingles/jingles_SAX16.ogg -4
lose hit music-jingles/jingles_HIT16.ogg -4
lose nes music-jingles/jingles_NES16.ogg -7
lose nes-2 music-jingles/jingles_NES10.ogg -7
lose low-down digital-audio/lowDown.ogg -7
lose error interface-sounds/error_005.ogg -4
EOF
)

rm -rf "$OUT"
last=''
n=0
while read -r slot name source peak; do
  pack=${source%%/*}
  file=$(find "$SRC/$pack" -name "${source#*/}" -print -quit)
  [ -n "$file" ] || { echo "missing: $source" >&2; exit 1; }
  # lines of one slot sit together; variants are numbered in the order listed
  if [ "$slot" != "$last" ]; then last=$slot; n=0; fi
  n=$((n + 1))
  dest=$(printf '%s/%s/%02d-%s.m4a' "$OUT" "$slot" "$n" "$name")
  mkdir -p "$(dirname "$dest")"
  trim="silenceremove=start_periods=1:start_threshold=-55dB,areverse,silenceremove=start_periods=1:start_threshold=-60dB,areverse,atrim=0:$MAX_SECONDS"
  max=$(ffmpeg -hide_banner -nostats -i "$file" -af "$trim,volumedetect" -ac 1 -f null - 2>&1 | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p')
  gain=$(echo "$peak - $max" | bc -l)
  ffmpeg -hide_banner -loglevel error -y -i "$file" -af "$trim,volume=${gain}dB" -ac 1 -ar 44100 -c:a aac -b:a 96k "$dest"
done <<< "$PICKS"
du -sh "$OUT"
