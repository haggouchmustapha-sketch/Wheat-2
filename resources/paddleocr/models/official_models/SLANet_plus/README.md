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
- table_structure_recognition
---

# SLANet_plus

## Introduction

Table structure recognition is an important component of table recognition systems, capable of converting non-editable table images into editable table formats (such as HTML). The goal of table structure recognition is to identify the positions of rows, columns, and cells in tables. The performance of this module directly affects the accuracy and efficiency of the entire table recognition system. The table structure recognition module usually outputs HTML code for the table area, which is then passed as input to the tabl recognition pipeline for further processing.

<table>
<tr>
<th>Model</th>
<th>Accuracy (%)</th>
<th>GPU Inference Time (ms)<br/>[Normal Mode / High Performance Mode]</th>
<th>CPU Inference Time (ms)<br/>[Normal Mode / High Performance Mode]</th>
<th>Model Storage Size (M)</th>
</tr>
<tr>
<td>SLANet_plus</td>
<td>63.69</td>
<td>140.29 / 140.29</td>
<td>195.39 / 195.39</td>
<td>6.9 M</td>
</tr>
</table>


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
paddleocr table_structure_recognition \
    --model_name SLANet_plus \
    -i https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/6rfhb-CXOHowonjpBsaUJ.png
```

You can also integrate the model inference of the table classification module into your project. Before running the following code, please download the sample image to your local machine.

```python
from paddleocr import TableStructureRecognition
model = TableStructureRecognition(model_name="SLANet_plus")
output = model.predict(input="UHf7jONQ3a18cszdL_Wuo.png", batch_size=1)
for res in output:
    res.print(json_format=False)
    res.save_to_json("./output/res.json")
```

After running, the obtained result is as follows:

```json
{'res': {'input_path': '6rfhb-CXOHowonjpBsaUJ.png', 'page_index': None, 'bbox': [[1, 2, 64, 2, 64, 41, 1, 41], [52, 1, 199, 1, 198, 38, 51, 38], [182, 1, 253, 1, 254, 40, 184, 40], [248, 1, 323, 1, 324, 41, 249, 41], [314, 1, 384, 1, 385, 40, 315, 40], [389, 2, 493, 2, 493, 45, 388, 44], [2, 42, 50, 42, 50, 77, 2, 77], [65, 42, 176, 42, 175, 77, 64, 77], [187, 40, 251, 40, 249, 79, 185, 79], [252, 41, 319, 41, 319, 80, 251, 80], [318, 40, 379, 40, 380, 78, 318, 78], [385, 39, 497, 39, 497, 84, 384, 83], [2, 82, 50, 82, 50, 118, 2, 118], [63, 80, 182, 80, 181, 114, 62, 114], [189, 80, 250, 80, 249, 114, 187, 114], [253, 80, 319, 80, 319, 114, 252, 114], [320, 78, 378, 79, 378, 114, 320, 114], [395, 77, 496, 78, 496, 118, 394, 118], [2, 117, 49, 118, 50, 155, 2, 155], [65, 115, 180, 115, 179, 151, 64, 151], [191, 115, 249, 115, 248, 150, 189, 150], [254, 115, 318, 115, 318, 150, 253, 150], [321, 114, 377, 114, 378, 150, 321, 150], [396, 113, 495, 113, 495, 154, 394, 153], [1, 153, 56, 153, 57, 192, 1, 191], [68, 152, 175, 152, 175, 189, 67, 189], [189, 152, 249, 152, 249, 188, 188, 188], [252, 152, 317, 152, 318, 188, 252, 188], [320, 150, 377, 151, 378, 188, 321, 187], [393, 150, 494, 151, 494, 193, 391, 192]], 'structure': ['<html>', '<body>', '<table>', '<tr>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '</tr>', '<tr>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '</tr>', '<tr>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '</tr>', '<tr>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '</tr>', '<tr>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '<td></td>', '</tr>', '</table>', '</body>', '</html>'], 'structure_score': 0.99635947}}
```

For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/module_usage/table_structure_recognition.html#iii-quick-start).

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

Run a single command to quickly experience the general table recognition V2 pipeline with default config, which uses the SLANeXt_wired and SLANeXt_wireless to predict the table structure:

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

Then, if you want to use the SLANet_plus model for table recognition, just change the model name and use the end-to-end prediction mode as below:

```bash
paddleocr table_recognition_v2 -i https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/mabagznApI1k9R8qFoTLc.png  \
    --use_doc_orientation_classify False  \
    --use_doc_unwarping False \
    --wired_table_structure_recognition_model_name SLANet_plus \ 
    --use_e2e_wired_table_rec_model True \
    --wireless_table_structure_recognition_model_name SLANet_plus \
    --use_e2e_wireless_table_rec_model True \
    --save_path ./output \
    --device gpu:0 
```

```python
from paddleocr import TableRecognitionPipelineV2

pipeline = TableRecognitionPipelineV2(
    use_doc_orientation_classify=False,
    use_doc_unwarping=False, 
    wired_table_structure_recognition_model_name=SLANet_plus,  ## for wired table recognition
    wireless_table_structure_recognition_model_name=SLANet_plus,  ## for wireless table recognition
)
output = pipeline.predict(
    "https://cdn-uploads.huggingface.co/production/uploads/681c1ecd9539bdde5ae1733c/mabagznApI1k9R8qFoTLc.png",
    use_e2e_wired_table_rec_model=True,  ## for wired table recognition
    use_e2e_wireless_table_rec_model=True,  ## for wireless table recognition
    )
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
    --wired_table_structure_recognition_model_name SLANet_plus \ 
    --use_e2e_wired_table_rec_model True \
    --wireless_table_structure_recognition_model_name SLANet_plus \
    --use_e2e_wireless_table_rec_model True \
    --use_textline_orientation False \
    --device gpu:0
```

Results would be printed to the terminal. If save_path is specified, the results will be saved under `save_path`. 

Just a few lines of code can experience the inference of the pipeline. Taking the PP-StructureV3 pipeline as an example:

```python
from paddleocr import PPStructureV3

pipeline = PPStructureV3(
    wired_table_structure_recognition_model_name=SLANet_plus,  ## for wired table recognition
    wireless_table_structure_recognition_model_name=SLANet_plus,  ## for wireless table recognition
    use_doc_orientation_classify=False, # Use use_doc_orientation_classify to enable/disable document orientation classification model
    use_doc_unwarping=False,    # Use use_doc_unwarping to enable/disable document unwarping module
    use_textline_orientation=False, # Use use_textline_orientation to enable/disable textline orientation classification model
    device="gpu:0", # Use device to specify GPU for model inference
    )
output = pipeline.predict(
    "mG4tnwfrvECoFMu-S9mxo.png",
    use_e2e_wired_table_rec_model=True,  ## for wired table recognition
    use_e2e_wireless_table_rec_model=True,  ## for wireless table recognition
    )
for res in output:
    res.print() # Print the structured prediction output
    res.save_to_json(save_path="output") ## Save the current image's structured result in JSON format
    res.save_to_markdown(save_path="output") ## Save the current image's result in Markdown format
```

The default model used in pipeline is `SLANeXt_wired` and `SLANeXt_wireless`, so it is needed that specifing to `SLANet_plus` by argument. For details about usage command and descriptions of parameters, please refer to the [Document](https://paddlepaddle.github.io/PaddleOCR/latest/en/version3.x/pipeline_usage/PP-StructureV3.html#2-quick-start).

## Links

[PaddleOCR Repo](https://github.com/paddlepaddle/paddleocr)

[PaddleOCR Documentation](https://paddlepaddle.github.io/PaddleOCR/latest/en/index.html)

