# Inference Worker (Epic 4, REQ-A03) — 완료 보고

원래 이 문서는 새 세션이 이전 대화 맥락 없이 착수할 수 있게 쓴 **착수 브리핑**이었음. Epic 4 구현이 끝난 지금은 **완료 보고**로 갱신함 — 당시의 분석/추천 근거는 그대로 남겨두되(맞았는지 틀렸는지 알 수 있게), 각 항목에 실제로 어떻게 귀결됐는지를 덧붙임. 상태 태그: **[확정]** = 실제로 결정되어 PRD/코드에 반영됨, **[일부 해소]** = 일부만 결론남, **[열림]** = 여전히 미해결.

---

## 0. 요약

- Inference Worker 1차 구현 완료. 위치: `viewer/src/workers/inference-worker/` (원래 예상했던 `ai-pipeline/inference/`가 아님 — 2번 사유는 6번 참고, 결정 근거는 `docs/adr/0002-inference-worker-in-viewer.md`).
- FP32 lungmask 모델 기준, 전처리→추론→후처리 전체 파이프라인이 Python 레퍼런스와 대조 검증됨 (7번 참고).
- **미완료로 남은 것**: INT8/FP16 모델 미검증, 슬라이스당 레이턴시 미측정, 좌표계/축 순서 미확인, 실제 브라우저 Worker 통합(번들링) 미검증 — 8번 갭 분석 참고.

## 1. 지금까지 나온 산출물 (Epic 1/2)

- 모델: `ai-pipeline/conversion/adapters/lungmask/lungmask_r231.onnx` (FP32, opset 18)
- 양자화 모델: `ai-pipeline/quantization/lungmask_r231_int8.onnx`, `lungmask_r231_fp16.onnx` (로컬에만 존재, gitignore — 필요시 `quantize_ptq.py`/`convert_fp16.py`로 재생성)
- 입출력 스펙 원본: `ai-pipeline/conversion/adapters/lungmask/MODEL_SPEC.md` — **Inference Worker 구현의 1차 근거 문서**
- 검증된 argmax 일치율: INT8 99.95%, FP16 100.00% (FP32 대비, 실제 CT 30장 기준) — 이건 Python 쪽 검증이고, Epic 4에서 TS/ONNX Runtime Web으로 이 두 모델을 돌려본 적은 없음 (8번 참고)
- 캘리브레이션 실제 DICOM 샘플: `ai-pipeline/quantization/calibration_data/selected/` (30장, 10명) — Epic 4에서 이 중 5장을 레퍼런스 픽스처로 사용함 (7번 참고)

## 2. 모델 입출력 스펙 요약 (전체는 MODEL_SPEC.md 참고)

- 입력: `[1, 1, 256, 256]` float32
- 전처리 4단계 (원본 HU 배열 → 모델 입력):
  1. HU를 `[-1024, 600]` 양쪽 클립
  2. `-500 HU` 임계값 + 형태학적 연산으로 바디 영역 검출
  3. 바디 bounding box로 **크롭한 뒤** 256×256으로 리사이즈 (`scipy.ndimage.zoom`, bilinear) — 단순 다운샘플 아님, 주의
  4. 상한 재클립 + `(HU + 1024) / 1624` 정규화
- 출력: `[1, 3, 256, 256]` raw logits (0=배경, 1=오른쪽 폐, 2=왼쪽 폐)
- 후처리(REQ-A17, 이 워커의 postprocess 단계가 담당): `argmax` → `uint8` 클래스 인덱스 → **Nearest-Neighbor만**으로 원본 DICOM 해상도로 업스케일 → 이 시점에만 REQ-C01 경계를 넘어 전달 가능

## 3. 아키텍처 — 전처리 위치 [확정, 2026-08-13]

**당시 제안(2026-08-11경)**: 위 4단계 중 1~4번(모델별 전처리)을 Parse Worker가 아니라 **Inference Worker가** 담당하는 쪽으로 검토·추천함 — 모델마다 달라지는 로직을 엔진 쪽 소유 Parse Worker에 심으면 모델 추가할 때마다 Parse Worker를 건드려야 하기 때문.

**실제 귀결**: 이 제안 그대로 확정됨. PRD REQ-A04가 2026-08-12 "AI Track — confirmed"로 갱신되어 이제 "Parse Worker는 디코딩+HU 변환까지만, 모델별 전처리는 Inference Worker의 어댑터 preprocess 단계"로 명시돼 있음. REQ-A15(버퍼 분리)와 REQ-C01 §5.3.1 "Input Source" 행도 같은 시점에 이 용어("raw HU tensor")로 맞춰 갱신됨. TS 구현은 6번 참고.

## 4. Inference Worker → Shell 계약 [PRD 확정, §5.3.2, AI Track 확인 완료]

> Inference Worker는 렌더링 엔진에 직접 연결되지 않음 — 결과를 Web Application Shell로 postMessage하면, Shell이 엔진 호출을 담당함.

```
mask-slice {
  volumeId: string,
  sliceIndex: number,
  width: number,
  height: number,
  data: ArrayBuffer   // Transferable, uint8, row-major, length = width*height
}
```

- **순서 무관**: 슬라이스가 어떤 순서로 도착하든 상관없음.
- `mask-complete`(volumeId, totalSlices), `mask-slice-error`(volumeId, sliceIndex, message)는 **P1 옵션, MVP에서 생략** — 실제로 구현 안 함.
- `width`/`height`는 원본 슬라이스 해상도(REQ-A17 업스케일 후 값).
- **실제 구현**: `src/pipeline.ts`의 `runSlice()`가 이 형태 그대로 반환. 단, 이건 순수 함수 레벨 검증이고 실제 `self.postMessage` + Transferable 경유 동작은 브라우저에서 확인 안 됨(6번 참고).

## 5. Parse Worker → Inference Worker 계약 [일부 해소]

- 슬라이스 하나당 shape/dtype: **확정** — 원본 해상도 float32 HU 값(REQ-A04 갱신으로 명문화됨).
- 슬라이스 단위 점진적 전달: **확정 방향대로** — REQ-A04/§5.3.2 전체가 슬라이스 단위 파이프라인을 전제로 확정됨.
- `volumeId` 포함: **확정** — §5.3.2가 Shell이 발급해서 세 컴포넌트에 흘려보낸다고 명시.
- 슬라이스 인덱스: 확정(§5.3.2 `sliceIndex`), 단 Parse Worker 쪽 원본 필드명(`InstanceNumber` 그대로 쓸지 등)은 여전히 미확정.
- **좌표계/축 방향(LPS 등) — 여전히 [열림].** 이번 세션에서도 다뤄지지 않음. Epic 4의 스텁/전처리 코드는 pydicom이 반환하는 배열을 그대로 사용해서 축 방향을 전혀 검증/보정하지 않음 — Parse Worker 실물이 붙기 전까지는 겉으로 드러나지 않지만, 실제 통합 시 뒤집힘/회전 같은 시각적 버그로만 나타날 것. **Daewon 확인 여전히 필요.**
- 백프레셔: 여전히 [열림], 미정.

## 6. 구현 내용 (Epic 4, 2026-08-13)

**위치**: `viewer/src/workers/inference-worker/` — 원래 이 문서 6번(구 버전)에서 제안했던 `ai-pipeline/inference/`가 아님. 팀원(엔진 트랙) 제안으로 Shell/Parse Worker와 같은 프로젝트(`viewer/`)에 두기로 변경 — 소비자가 이 웹 앱 하나뿐이라 독립 패키지로 둘 근거가 없고(dicom-parser가 최상위로 분리된 것과 반대 케이스: 그쪽은 소비자가 둘이라 분리, 이쪽은 소비자가 하나라 통합), Worker 번들링도 같은 프로젝트 그래프 안에 있어야 자연스러움. 근거/대안 전체는 `docs/adr/0002-inference-worker-in-viewer.md`. `CODEOWNERS`에 `/viewer/src/workers/inference-worker/ @hyuniverse` 서브패스 오버라이드 추가함.

**구조**:
```
viewer/src/workers/inference-worker/
  src/
    adapters/
      types.ts                 SegmentationAdapter 인터페이스 (preprocess/infer/postprocess)
      lungmask/
        ndimage.ts              scipy.ndimage/skimage.measure 핵심 연산 재구현
        preprocess.ts            MODEL_SPEC.md 4단계
        postprocess.ts           argmax + NN 업스케일 (REQ-A17)
        index.ts                 LungmaskAdapter
    pipeline.ts                 runSlice(): preprocess→infer→postprocess→§5.3.2 페이로드 (순수 함수)
    worker.ts                   self.onmessage 래퍼 (얇음, 미검증 — 아래 참고)
  scripts/export_reference_fixtures.py   Python 레퍼런스 픽스처 생성 (7번 참고)
  test/                         vitest, Python 레퍼런스 대조
```

`ai-track-decisions.md` #2가 미해결로 남겨뒀던 `SegmentationAdapter` Protocol을 이번에 TS로 구체화함 (`organ_taxonomy.json`/`registry.json`은 여전히 YAGNI로 미생성 — 어댑터가 하나뿐이라 필요성 없음).

**구현 중 발견한 것 — `scipy.ndimage.zoom`의 좌표 매핑**: 처음에 half-pixel-center 방식(`ix = (o+0.5)*scale - 0.5`, PIL/OpenCV/TensorFlow에서 흔한 컨벤션)으로 구현했다가 바디마스크 bbox가 Python 레퍼런스와 전부 어긋남. 실제 scipy 기본 동작(`grid_mode=False`)은 "align corners" 방식(`ix = o*(in_size-1)/(out_size-1)`)이라는 걸 단계별 중간값 대조로 확인 후 수정 — 지금은 512→128 다운샘플부터 최종 마스크까지 전 단계가 Python과 bit-exact 일치함. **다른 모델 어댑터를 추가할 때도 이 함정을 다시 밟지 않도록 `ndimage.ts`의 `srcCoord()` 주석에 남겨둠.**

**`worker.ts`는 미검증**: `self.onmessage` 래퍼는 작성했지만 실제 브라우저(또는 Node worker_threads)에서 postMessage/Transferable 경로로 실행해본 적 없음 — 번들러 미선정 상태라 이번 범위에서 의도적으로 제외함(8번 참고).

## 7. 테스트 결과

**방법론**: `scripts/export_reference_fixtures.py`가 `ai-pipeline/quantization/preprocessing.py`(기존 Epic 2 코드, `lungmask.utils.preprocess` 재사용)를 그대로 호출해서 calibration_data/selected/ 중 5장에 대해 raw HU 배열, 레퍼런스 전처리 텐서, 레퍼런스 후처리 마스크(FP32 ONNX 모델 기준)를 덤프. TS 테스트가 이 값들과 직접 diff.

**결과 (2026-08-13, 클린 재설치 후 재확인 완료)**:
- `npm run typecheck` — 클린
- `npm test` — **18/18 통과**
  - 전처리: 바디마스크 bbox 5/5 정확히 일치, 정규화된 텐서 max-abs-diff < 1e-3 (실제로는 위 zoom 버그 수정 후 bit-exact에 가까움)
  - 후처리: 합성 데이터로 NN 업스케일 정확성, 클래스 인덱스 범위 검증
  - 엔드투엔드: 5장 전체 argmax 불일치율 < 1% (Epic 1의 Python 자체 parity 결과와 부합), `mask-slice` 페이로드가 §5.3.2 형태와 정확히 일치

**검증 범위의 한계**: FP32 모델만 대상. `onnxruntime-web`이 Node에서 external-data(`.onnx.data`) 파일을 자동으로 못 찾는 문제가 있어 테스트에서는 버퍼를 명시적으로 읽어서 넘기는 방식으로 우회함(`test/pipeline.test.ts` 참고) — 실제 브라우저 환경(fetch 기반)에서도 동일하게 동작하는지는 미확인.

## 8. 이슈 DoD 대비 갭 분석 (2026-08-13 기준)

| 항목 | 상태 |
|---|---|
| Step 0: 전처리 소유권 확정 + PRD 갱신 | ⚠️ PRD는 갱신됨("AI Track — confirmed" 태그) but Daewon이 실제로 관여했는지는 이 세션만으론 확인 불가 |
| Step 0: 좌표계/축 순서 확인 | ❌ 전혀 다루지 않음 (5번 참고) |
| Step 1: TS 프로젝트 + onnxruntime-web | ✅ 완료 |
| Step 2: 전처리 구현 + Python 대조 | ✅ 완료 (bit-exact까지, 기준 초과) |
| Step 3: FP32/INT8/FP16 전부 ORT Web 구동 | ❌ **FP32만.** INT8/FP16 미시도 — 특히 quantized op의 WASM 백엔드 커버리지가 Python onnxruntime과 다를 수 있어 리스크로 남아있음 |
| Step 3: 슬라이스당 레이턴시 측정 | ❌ 전혀 측정 안 함 |
| Step 4: 후처리 (argmax + NN) | ✅ 완료 |
| Step 5: mask-slice 메시지 (§5.3.2) | ✅ 완료 — 단, `pipeline.ts` 함수 레벨 검증이고 `worker.ts`의 실제 postMessage 경로는 미검증 |
| DoD: calibration_data로 end-to-end 테스트 | ✅ 완료 (역시 함수 레벨) |

## 9. 참고 문서

- `ai-pipeline/conversion/adapters/lungmask/MODEL_SPEC.md` — 모델 입출력 스펙 원본
- `ai-pipeline/mask-assembly-architecture-review.md` — 3D 마스크 조립을 엔진이 하는 이유, 대안 검토 (§5.3.1 MVP 스코프가 2026-08-12 브릭 아틀라스→직접 텍스처 기록으로 바뀐 점은 이 문서에 아직 반영 안 됨 — 별도 갱신 필요)
- `docs/adr/0002-inference-worker-in-viewer.md` — Inference Worker가 `viewer/` 안에 있는 이유
- `docs/ai-track-decisions.md` — 전체 결정 로그(로컬 전용, git 미추적)
- `docs/prd/PRD.md` §5.2(REQ-A03~A06, A17), §5.3(REQ-C01/C04), §5.3.1, §5.3.2
