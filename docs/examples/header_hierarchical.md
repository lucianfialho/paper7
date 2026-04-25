# BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding

**Authors:** Jacob Devlin, Ming-Wei Chang, Kenton Lee, Kristina Toutanova
**arXiv:** https://arxiv.org/abs/1810.04805

**Summary:** We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. Unlike recent language representation models, BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers. As a result, the pre-trained BERT model can be fine-tuned with just one additional output layer to create state-of-the-art models for a wide range of tasks, such as question answering and language inference, without substantial task-specific architecture modif...

## Sections

> Fetch a range: `paper7 get 1810.04805 --detailed --range START:END`  
> Full paper:    `paper7 get 1810.04805 --detailed`

- [Introduction](#L17-L29)
- [Related Work](#L30-L43)
  - [Unsupervised Feature-based Approaches](#L32-L37)
  - [Unsupervised Fine-tuning Approaches](#L38-L41)
  - [Transfer Learning from Supervised Data](#L42-L43)
- [BERT](#L44-L81)
    - [Model Architecture](#L48-L53)
    - [Input/Output Representations](#L54-L61)
  - [Pre-training BERT](#L62-L73)
    - [Task #1: Masked LM](#L64-L69)
    - [Task #2: Next Sentence Prediction (NSP)](#L70-L73)
  - [Fine-tuning BERT](#L74-L81)
- [Experiments](#L82-L115)
  - [GLUE](#L84-L93)
  - [SQuAD v1.1](#L94-L101)
  - [SQuAD v2.0](#L102-L107)
  - [SWAG](#L108-L115)
- [Ablation Studies](#L116-L143)
  - [Effect of Pre-training Tasks](#L118-L127)
  - [Effect of Model Size](#L128-L133)
  - [Feature-based Approach with BERT](#L134-L143)
- [Conclusion](#L144-L145)
- [References](#L146-L214)
- [Additional Details for BERT](#L215-L260)
  - [Illustration of the Pre-training Tasks](#L217-L231)
    - [Masked LM and the Masking Procedure](#L219-L227)
    - [Next Sentence Prediction](#L228-L231)
  - [Pre-training Procedure](#L232-L239)
  - [Fine-tuning Procedure](#L240-L246)
  - [Comparison of BERT, ELMo ,and OpenAI GPT](#L247-L256)
  - [Illustrations of Fine-tuning on Different Tasks](#L257-L260)
- [Detailed Experimental Setup](#L261-L282)
  - [Detailed Descriptions for the GLUE Benchmark Experiments.](#L263-L282)
    - [MNLI](#L265-L266)
    - [QQP](#L267-L268)
    - [QNLI](#L269-L270)
    - [SST-2](#L271-L272)
    - [CoLA](#L273-L274)
    - [STS-B](#L275-L276)
    - [MRPC](#L277-L278)
    - [RTE](#L279-L280)
    - [WNLI](#L281-L282)
- [Additional Ablation Studies](#L283-L302)
  - [Effect of Number of Training Steps](#L285-L292)
  - [Ablation for Different Masking Procedures](#L293-L302)
