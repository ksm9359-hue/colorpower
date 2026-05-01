# 밸런스 수치 기준 파일 (Offset Source)

이 문서는 실제 게임 밸런스의 기준이 되는 **오프셋 수치 원본 파일**입니다.  
`v0.2`부터는 실시간 난이도 상승 대신, **라운드 단위 난이도 상승**을 기본 방식으로 사용합니다.

실제 편집 원본: `balance-config.json`  
런타임 적용: `src/main.ts`가 `balance-config.json`을 import하여 동일 수식으로 계산한다.  
그래프 생성 명령: `npm run balance:graphs` (PowerShell 정책 이슈 시 `npm.cmd run balance:graphs`)

---

## 1) v0.2 운영 파라미터 (Round Set)

아래 파라미터는 `v0.2` 라운드 밸런스 기준입니다.

| 분류 | 키 | 권장 시작값 |
|---|---|---:|
| 시작 라운드 | `roundStart` | 1 |
| 라운드 전투 시간(초) | `roundDurationSec` | 30 |
| 라운드 간 선택 페이즈(초) | `perkPhaseSec` | 8 |
| 라운드 HUD 남은시간 표시 | `showRoundRemainSec` | true |
| 기본 점수 | `scorePerCatch` | 10 |
| 3매칭 보너스 | `matchBonusScore` | 100 |
| 게임오버 부착 한계 | `attachedLimit` | 6 |
| 라운드별 스폰 간격 시작(ms) | `spawnDelayBaseMs` | 760 |
| 라운드당 스폰 간격 감소(ms) | `spawnDelayStepMs` | 35 |
| 스폰 간격 최소(ms) | `spawnDelayMinMs` | 240 |
| 라운드별 낙하 속도 시작 | `dropSpeedBase` | 1.0 |
| 라운드당 낙하 속도 증가 | `dropSpeedStep` | 0.28 |
| 낙하 속도 최대 | `dropSpeedMax` | 7.5 |
| 라운드별 동시 스폰 시작 | `spawnCountBase` | 1 |
| 라운드당 동시 스폰 증가 배율 | `spawnCountStepFactor` | 0.33 |
| 동시 스폰 최대 | `spawnCountMax` | 5 |
| 점수 난이도 배율 | `scoreDifficultyFactor` | 4.0 |
| 폭탄 등장 기본 확률(해당 라운드) | `bombSpawnChance` | 0.12 |
| 폭탄 제거 점수 계수 | `bombClearScoreFactor` | 6 |
| 라운드당 BGM 속도 상승량 | `bgmRateRoundStep` | 0.05 |

---

## 2) v0.2 라운드 계산식 (적용 기준)

라운드 번호를 `r`(1부터 시작)로 두고 아래 식으로 고정값을 계산합니다.

- `spawnDelay(r) = max(spawnDelayMinMs, spawnDelayBaseMs - (r - 1) * spawnDelayStepMs)`
- `dropSpeed(r) = min(dropSpeedMax, dropSpeedBase + (r - 1) * dropSpeedStep)`
- `spawnCount(r) = min(spawnCountMax, floor(spawnCountBase + (r - 1) * spawnCountStepFactor))`
- `difficultyScoreOffset(r) = round((spawnCount(r) - 1) * scoreDifficultyFactor)`
- `catchScore(r) = scorePerCatch + difficultyScoreOffset(r)`

### 라운드 진행 규칙

- 전투 페이즈 동안(`roundDurationSec`) 위 값은 고정
- 전투 페이즈 종료 후 `perkPhaseSec` 동안 낙하물 정지 + 퍽 2지 선택
- 다음 라운드 시작 시 `r + 1` 값으로 스텝 상승
- 라운드 HUD에 `Round N` + `다음 라운드까지 남은 시간`을 표시

---

## 3) v0.2 샘플 라운드 표 (검증 기준)

| Round | 전투시간(sec) | 선택페이즈(sec) | spawnDelay(ms) | dropSpeed | spawnCount | catchScore |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 30 | 8 | 760 | 1.00 | 1 | 10 |
| 2 | 30 | 8 | 725 | 1.28 | 1 | 10 |
| 3 | 30 | 8 | 690 | 1.56 | 1 | 10 |
| 4 | 30 | 8 | 655 | 1.84 | 1 | 10 |
| 5 | 30 | 8 | 620 | 2.12 | 2 | 14 |
| 6 | 30 | 8 | 585 | 2.40 | 2 | 14 |
| 7 | 30 | 8 | 550 | 2.68 | 2 | 14 |
| 8 | 30 | 8 | 515 | 2.96 | 3 | 18 |

---

## 4) 퍽 영향 반영 규칙 (v0.2)

- `캐릭터 확장`: `attachedLimit + 1`, 플레이어 폭 증가
- `이동 속도 UP`: 플레이어 이동 속도 상향
- `다음 라운드 컬러 타입 -1`: 다음 라운드에만 컬러 풀 축소
- `특정 컬러 점수 보너스`: 지정 컬러 충돌/매칭 시 추가 점수
- `생성 속도 -`: 해당 라운드 `spawnDelay(r)` 증가 보정
- `낙하 속도 -`: 해당 라운드 `dropSpeed(r)` 감소 보정
- `해당 라운드 폭탄 등장`: 선택한 라운드 전투 페이즈에서 확률로 폭탄 등장 활성화

> 퍽은 세션 누적이며, 게임오버 시 초기화.

### 4-1. 퍽 제시/중첩 규칙 (확정)

- 한 번의 2지 선택 화면에서 같은 퍽 중복 제시 금지
- 스택 가능한 퍽은 반복 등장 가능
- 퍽별 최대 중첩 도달 시 해당 퍽은 이후 선택지 풀에서 제외

### 4-2. 퍽 최대 중첩 테이블 (권장 시작값)

| 퍽 | 키 | 최대 중첩 |
|---|---|---:|
| 캐릭터 확장 | `perkExpandPlayerMaxStack` | 2 |
| 이동 속도 UP | `perkMoveSpeedMaxStack` | 3 |
| 다음 라운드 컬러 타입 -1 | `perkColorReduceMaxStack` | 2 |
| 특정 컬러 점수 보너스 | `perkColorScoreBonusMaxStack` | 4 |
| 생성 속도 - | `perkSpawnDelayNerfMaxStack` | 3 |
| 낙하 속도 - | `perkDropSpeedNerfMaxStack` | 3 |
| 해당 라운드 폭탄 등장 | `perkBombRoundMaxStack` | 1 |

---

## 5) 폭탄 낙하물 점수식 (v0.2 확정)

- 폭탄 포함 매칭 성공 시:
  - 화면 내 낙하물 전부 제거
  - 플레이어에 이미 부착된 낙하물도 전부 제거
  - `bombClearBonus = clearedDrops * bombClearScoreFactor`
  - 최종 추가점수: `bombClearBonus + matchBonusScore`
- 제한 계수:
  - 별도 상한 계수 없음 (화면/부착물 총량이 자연 상한)
- 등장 규칙:
  - 폭탄 관련 퍽 획득 시 해당 라운드에서 `bombSpawnChance`로 확률 등장

---

## 6) (레거시) v0.1 실시간 커브 방식

아래는 `v0.1`에서 사용한 실시간 상승 방식 참고 자료입니다.

### 6-1. 정규화 시간

- `p = clamp(t / roundDurationSec, 0, 1)`

### 6-2. 스폰 간격 커브

- `spawnDelay(t) = spawnDelayStartMs - (spawnDelayStartMs - spawnDelayMinMs) * p^spawnCurvePower`

### 6-3. 낙하 속도 커브

- `dropSpeed(t) = dropSpeedStart + (dropSpeedMax - dropSpeedStart) * p^speedCurvePower`

### 6-4. 동시 스폰 수 커브

- `spawnCountRaw(t) = spawnCountMin + (spawnCountMax - spawnCountMin) * p^spawnCountCurvePower`
- `spawnCount(t) = floor(spawnCountRaw(t))`

### 6-5. 점수 커브

- `difficultyScoreOffset(t) = round((spawnCount(t) - 1) * scoreDifficultyFactor)`
- `catchScore(t) = scorePerCatch + difficultyScoreOffset(t)`

---

## 7) 커브 그래프 관리 기준 (레거시 참고)

그래프는 별도 웨이브 표 대신 아래 3개 라인으로 관리합니다.

1. `spawnDelay(t)` 라인: 우하향(초반 완만, 후반 가속)
2. `dropSpeed(t)` 라인: 우상향(초반 완만, 후반 가속)
3. `spawnCount(t)` 라인: 계단형 우상향(최대값은 `spawnCountMax`)

권장 목표 형태:
- 초반(0~20%): 변화량 작게 (학습 구간)
- 중반(20~60%): 체감 변화 시작 (선택 압박)
- 후반(60~100%): 리스크 급증 (고득점/즉사 공존)

### 7-1. 생성된 그래프 확인

#### Spawn Delay
![Spawn Delay Curve](docs/balance-graphs/spawn-delay.svg)

#### Drop Speed
![Drop Speed Curve](docs/balance-graphs/drop-speed.svg)

#### Spawn Count
![Spawn Count Curve](docs/balance-graphs/spawn-count.svg)

#### Catch Score
![Catch Score Curve](docs/balance-graphs/catch-score.svg)

---

## 8) 샘플 포인트 표 (v0.1 레거시 기준)

| t(초) | p | spawnDelay(t) ms | dropSpeed(t) | spawnCount(t) | catchScore(t) |
|---:|---:|---:|---:|---:|---:|
| 0 | 0.00 | 760 | 1.50 | 1 | 0 |
| 10 | 0.10 | 750 | 1.72 | 1 | 0 |
| 25 | 0.25 | 711 | 2.27 | 1 | 0 |
| 40 | 0.40 | 638 | 3.00 | 1 | 0 |
| 50 | 0.50 | 581 | 3.47 | 1 | 0 |
| 75 | 0.75 | 402 | 5.25 | 2 | 4 |
| 100 | 1.00 | 260 | 7.20 | 4 | 12 |

---

## 9) 프리셋 템플릿

### Preset A - 학습 친화

- `spawnCurvePower`: 1.95
- `speedCurvePower`: 1.65
- `spawnCountCurvePower`: 2.10
- `scoreDifficultyFactor`: 3.0
- `attachedLimit`: 7

### Preset B - 현재안(기준선)

- `운영 파라미터 (Factor Set)` 그대로 사용

### Preset C - 하드코어

- `spawnCurvePower`: 1.25
- `speedCurvePower`: 1.15
- `spawnCountCurvePower`: 1.30
- `scoreDifficultyFactor`: 5.0
- `attachedLimit`: 5

---

## 10) 플레이테스트 로그 템플릿

```md
### Test #01
- 날짜:
- 빌드:
- 프리셋: (A/B/C/커스텀)
- Factor 변경값:
- 평균 생존 시간:
- 평균 점수:
- 3매칭 성공 횟수(평균):
- 체감 난이도(1~5):
- 불쾌 포인트:
- 다음 수정안:
```

---

## 11) 확정 후보 규칙

1. 초반(0~20초) 80% 이상이 조작 적응 가능
2. 중반(20~60초)에서 선택 압박이 분명히 느껴짐
3. 후반(60초+)은 고득점 가능하지만 실수 시 즉시 리스크 체감

