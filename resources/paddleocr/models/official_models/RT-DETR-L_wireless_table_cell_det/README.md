---
license: apache-2.0
library_name: PaddleOCR
language:
- en
- zh
pipeline_tag: image-to-text
tags:
- OCR
- PaddlePaddle
- PaddleOCR
- table_cells_detection
---

# RT-DETR-L_wireless_table_cell_det

## Introduction

The Table Cell Detection Module is a key component of the table recognition task, responsible for locating and marking each cell region in table images. The performance of this module directly affects the accuracy and efficiency of the entire table recognition process. The Table Cell Detection Module typically outputs bounding boxes for each cell region, which are then passed as input to the table recognition pipeline for further processing.


<table>
<tr>
<th>Model</th>
<th>Top1 Acc(%)</th>
<th>GPU Inference Time (ms)<br/>[Regular Mode / High-Performance Mode]</th>
<th>CPU Inference Time (ms)<br/>[Regular Mode / High-Performance Mode]</th>
<th>Model Storage Size (M)</th>
</tr>
<tr>
<td>RT-DETR-L_wireless_table_cell_det</td>
<td>82.7</td>
<td>35.00 / 10.45</td>
<td>495.51 / 495.51</td>
<td>124M</td>
</tr>
</table>

**Note**: The accuracy of RT-DETR-L_wireless_table_cell_det comes from the results of joint testing with RT-DETR-L_wired_table_cell_det.


### Installation

1. PaddlePaddle

Please refer to the following commands to install PaddlePaddle using pip:

```bash
# for CUDA11.8
python -m pip install paddlepaddle-gpu==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu118/

# for CUDA12.6
python -m pip install paddlepaddle-gpu==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/

# for CPU
python -m pip install paddlepaddle==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
```

For details about PaddlePaddle installation, please refer to the [PaddlePaddle official website](https://www.paddlepaddle.org.cn/en/install/quick).

2. PaddleOCR

Install the latest version of the PaddleOCR inference package from PyPI:

```bash
python -m pip install paddleocr
```

### Model Usage

You can quickly experience the functionality with a single command:

```bash
paddleocr table_cells_detection \
    --model_name RT-DETR-L_wireless_table_cell_det \
    -i https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/6rfhb-CXOHowonjpBsaUJ.png
```

You can also integrate the model inference of the table classification module into your project. Before running the following code, please download the sample image to your local machine.

```python
from paddleocr import TableCellsDetection
model = TableCellsDetection(model_name="RT-DETR-L_wireless_table_cell_det")
output = model.predict("6rfhb-CXOHowonjpBsaUJ.png", threshold=0.3, batch_size=1)
for res in output:
    res.print(json_format=False)
    res.save_to_img("./output/")
    res.save_to_json("./output/res.json")
```

After running, the obtained result is as follows:

```json
{'res': {'input_path': '6rfhb-CXOHowonjpBsaUJ.png', 'page_index': None, 'boxes': [{'cls_id': 0, 'label': 'cell', 'score': 0.9398849606513977, 'coordinate': [54.36941, 112.458046, 199.20259, 148.8335]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9389436841011047, 'coordinate': [54.376297, 38.66652, 200.09431, 75.04275]}, {'cls_id': 0, 'label': 'cell', 'score': 0.93695068359375, 'coordinate': [54.526768, 75.07727, 199.69261, 112.47577]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9276502132415771, 'coordinate': [256.82742, 112.23729, 327.20367, 148.69609]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9260919690132141, 'coordinate': [392.2286, 112.35808, 494.87323, 148.67969]}, {'cls_id': 0, 'label': 'cell', 'score': 0.926089882850647, 'coordinate': [55.078747, 148.77213, 198.78673, 181.62665]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9243109822273254, 'coordinate': [256.32922, 74.816475, 327.04968, 112.294014]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9232685565948486, 'coordinate': [54.62298, 6.616625, 199.83049, 38.849678]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9232298135757446, 'coordinate': [327.01968, 112.26065, 392.36826, 148.74333]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9225671291351318, 'coordinate': [256.76163, 39.040295, 326.9102, 74.86264]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9212655425071716, 'coordinate': [326.59286, 74.8661, 392.7218, 112.223015]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9207153916358948, 'coordinate': [392.2682, 74.9181, 494.8996, 112.21204]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9201209545135498, 'coordinate': [393.05807, 39.280144, 494.52887, 74.76607]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9167036414146423, 'coordinate': [326.6303, 38.908886, 392.46747, 74.80093]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9165226817131042, 'coordinate': [198.91599, 112.36962, 256.72226, 148.70464]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9159488081932068, 'coordinate': [200.06506, 38.73822, 256.86224, 74.968956]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9144055843353271, 'coordinate': [199.15344, 74.948166, 256.92688, 112.3458]}, {'cls_id': 0, 'label': 'cell', 'score': 0.909517228603363, 'coordinate': [256.9021, 148.65999, 327.34952, 180.787]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9079439043998718, 'coordinate': [392.5967, 148.63753, 494.56372, 180.72824]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9076585173606873, 'coordinate': [393.64462, 6.3321157, 494.12646, 38.97421]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9043015837669373, 'coordinate': [256.7985, 6.373327, 326.6927, 39.124607]}, {'cls_id': 0, 'label': 'cell', 'score': 0.9015249609947205, 'coordinate': [327.21558, 148.66805, 392.69656, 180.74384]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8990758061408997, 'coordinate': [199.04855, 6.3791466, 256.9587, 38.893078]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8976367712020874, 'coordinate': [326.987, 6.264301, 393.08954, 39.058624]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8959962129592896, 'coordinate': [198.89633, 148.7314, 256.86224, 181.1719]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8942931294441223, 'coordinate': [7.233109, 112.34024, 55.069206, 148.63686]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8866638541221619, 'coordinate': [7.6031237, 75.04754, 54.86649, 112.31445]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8835263848304749, 'coordinate': [7.8346314, 38.471584, 54.338577, 75.0842]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8768432140350342, 'coordinate': [6.3656106, 148.65721, 55.30119, 181.48982]}, {'cls_id': 0, 'label': 'cell', 'score': 0.8766786456108093, 'coordinate': [8.270618, 6.590586, 54.000782, 38.58467]}]}}
```

The visualized image is as follows:

![image/jpeg](https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/1xl59kTTNqRDdjnQ_Uxvc.png)

For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/module_usage/table_cells_detection.html#iii-quick-start).

### Pipeline Usage

The ability of a single model is limited. But the pipeline consists of several models can provide more capacity to resolve difficult problems in real-world scenarios.

#### General Table Recognition V2 Pipeline

The general table recognition V2 pipeline is used to solve table recognition tasks by extracting information from images and outputting it in HTML or Excel format. And there are 8 modules in the pipeline: 
* Table Classification Module
* Table Structure Recognition Module
* Table Cell Detection Module
* Text Detection Module
* Text Recognition Module
* Layout Region Detection Module (Optional)
* Document Image Orientation Classification Module (Optional)
* Text Image Unwarping Module (Optional)

Run a single command to quickly experience the general table recognition V2 pipeline:

```bash

paddleocr table_recognition_v2 -i https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/mabagznApI1k9R8qFoTLc.png  \
    --use_doc_orientation_classify False  \
    --use_doc_unwarping False \
    --save_path ./output \
    --device gpu:0 
```

Results are printed to the terminal:

```json
{'res': {'input_path': 'mabagznApI1k9R8qFoTLc.png', 'page_index': None, 'model_settings': {'use_doc_preprocessor': False, 'use_layout_detection': True, 'use_ocr_model': True}, 'layout_det_res': {'input_path': None, 'page_index': None, 'boxes': [{'cls_id': 8, 'label': 'table', 'score': 0.86655592918396, 'coordinate': [0.0125130415, 0.41920784, 1281.3737, 585.3884]}]}, 'overall_ocr_res': {'input_path': None, 'page_index': None, 'model_settings': {'use_doc_preprocessor': False, 'use_textline_orientation': False}, 'dt_polys': array([[[   9,   21],
        ...,
        [   9,   59]],

       ...,

       [[1046,  536],
        ...,
        [1046,  573]]], dtype=int16), 'text_det_params': {'limit_side_len': 960, 'limit_type': 'max', 'thresh': 0.3, 'box_thresh': 0.6, 'unclip_ratio': 2.0}, 'text_type': 'general', 'textline_orientation_angles': array([-1, ..., -1]), 'text_rec_score_thresh': 0, 'rec_texts': ['部门', '报销人', '报销事由', '批准人：', '单据', '张', '合计金额', '元', '车费票', '其', '火车费票', '飞机票', '中', '旅住宿费', '其他', '补贴'], 'rec_scores': array([0.99958128, ..., 0.99317062]), 'rec_polys': array([[[   9,   21],
        ...,
        [   9,   59]],

       ...,

       [[1046,  536],
        ...,
        [1046,  573]]], dtype=int16), 'rec_boxes': array([[   9, ...,   59],
       ...,
       [1046, ...,  573]], dtype=int16)}, 'table_res_list': [{'cell_box_list': [array([ 0.13052222, ..., 73.08310249]), array([104.43082511, ...,  73.27777413]), array([319.39041221, ...,  73.30439308]), array([424.2436837 , ...,  73.44736794]), array([580.75836265, ...,  73.24003914]), array([723.04370201, ...,  73.22717598]), array([984.67315757, ...,  73.20420387]), array([1.25130415e-02, ..., 5.85419208e+02]), array([984.37072837, ..., 137.02281502]), array([984.26586998, ..., 201.22290352]), array([984.24017417, ..., 585.30775765]), array([1039.90606773, ...,  265.44664314]), array([1039.69549644, ...,  329.30540779]), array([1039.66546714, ...,  393.57319954]), array([1039.5122689 , ...,  457.74644783]), array([1039.55535972, ...,  521.73030403]), array([1039.58612144, ...,  585.09468392])], 'pred_html': '<html><body><table><tbody><tr><td>部门</td><td></td><td>报销人</td><td></td><td>报销事由</td><td></td><td colspan="2">批准人：</td></tr><tr><td colspan="6" rowspan="8"></td><td colspan="2">单据 张</td></tr><tr><td colspan="2">合计金额 元</td></tr><tr><td rowspan="6">其 中</td><td>车费票</td></tr><tr><td>火车费票</td></tr><tr><td>飞机票</td></tr><tr><td>旅住宿费</td></tr><tr><td>其他</td></tr><tr><td>补贴</td></tr></tbody></table></body></html>', 'table_ocr_pred': {'rec_polys': array([[[   9,   21],
        ...,
        [   9,   59]],

       ...,

       [[1046,  536],
        ...,
        [1046,  573]]], dtype=int16), 'rec_texts': ['部门', '报销人', '报销事由', '批准人：', '单据', '张', '合计金额', '元', '车费票', '其', '火车费票', '飞机票', '中', '旅住宿费', '其他', '补贴'], 'rec_scores': array([0.99958128, ..., 0.99317062]), 'rec_boxes': array([[   9, ...,   59],
       ...,
       [1046, ...,  573]], dtype=int16)}}]}}
```

If save_path is specified, the visualization results will be saved under `save_path`. The visualization output is shown below:

![image/jpeg](https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/b3mPpaMsK049qxsTbotvI.png)

The command-line method is for quick experience. For project integration, also only a few codes are needed as well:

```python
from paddleocr import TableRecognitionPipelineV2

pipeline = TableRecognitionPipelineV2(
    use_doc_orientation_classify=False, # Use use_doc_orientation_classify to enable/disable document orientation classification model
    use_doc_unwarping=False, # Use use_doc_unwarping to enable/disable document unwarping module
)
# pipeline = TableRecognitionPipelineV2(use_doc_orientation_classify=True) # Specify whether to use the document orientation classification model with use_doc_orientation_classify
# pipeline = TableRecognitionPipelineV2(use_doc_unwarping=True) # Specify whether to use the text image unwarping module with use_doc_unwarping
# pipeline = TableRecognitionPipelineV2(device="gpu") # Specify the device to use GPU for model inference
output = pipeline.predict("https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/mabagznApI1k9R8qFoTLc.png")
for res in output:
    res.print() ## Print the predicted structured output
    res.save_to_img("./output/")
    res.save_to_xlsx("./output/")
    res.save_to_html("./output/")
    res.save_to_json("./output/")
```

For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/table_recognition_v2.html#2-quick-start).

#### PP-StructureV3

Layout analysis is a technique used to extract structured information from document images. PP-StructureV3 includes the following six modules:
* Layout Detection Module
* General OCR Pipeline
* Document Image Preprocessing Pipeline （Optional）
* Table Recognition Pipeline （Optional）
* Seal Recognition Pipeline （Optional）
* Formula Recognition Pipeline （Optional）

Run a single command to quickly experience the PP-StructureV3 pipeline:

```bash
paddleocr pp_structurev3 -i https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/mG4tnwfrvECoFMu-S9mxo.png \
    --use_doc_orientation_classify False \
    --use_doc_unwarping False \
    --use_textline_orientation False \
    --device gpu:0
```

Results would be printed to the terminal. If save_path is specified, the results will be saved under `save_path`. 

Just a few lines of code can experience the inference of the pipeline. Taking the PP-StructureV3 pipeline as an example:

```python
from paddleocr import PPStructureV3

pipeline = PPStructureV3(
    use_doc_orientation_classify=False, # Use use_doc_orientation_classify to enable/disable document orientation classification model
    use_doc_unwarping=False,    # Use use_doc_unwarping to enable/disable document unwarping module
    use_textline_orientation=False, # Use use_textline_orientation to enable/disable textline orientation classification model
    device="gpu:0", # Use device to specify GPU for model inference
    )
output = pipeline.predict("./pp_structure_v3_demo.png")
for res in output:
    res.print() # Print the structured prediction output
    res.save_to_json(save_path="output") ## Save the current image's structured result in JSON format
    res.save_to_markdown(save_path="output") ## Save the current image's result in Markdown format
```

For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/latest/en/version3.x/pipeline_usage/PP-StructureV3.html#2-quick-start).

## Links

[PaddleOCR Repo](https://github.com/paddlepaddle/paddleocr)

[PaddleOCR Documentation](https://paddlepaddle.github.io/PaddleOCR/latest/en/index.html)

