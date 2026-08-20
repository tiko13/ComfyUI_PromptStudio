param(
    [Parameter(Mandatory = $true)]
    [string] $ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
if ([System.IO.Path]::GetExtension($ConfigPath) -ine ".json") {
    throw "The Prompt Studio Llama.cpp config must be a JSON file."
}

$configDirectory = Split-Path -Parent $ConfigPath
if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
    throw "The config directory does not exist: $configDirectory"
}

$config = @{}
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    if ((Get-Item -LiteralPath $ConfigPath).Length -gt 65536) {
        throw "The Llama.cpp config exceeds the 64 KB limit."
    }
    $loaded = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $loaded) {
        foreach ($property in $loaded.PSObject.Properties) {
            $config[$property.Name] = $property.Value
        }
    }
}

function Get-ConfigValue {
    param([string[]] $Names, $Default = "")
    foreach ($name in $Names) {
        if ($config.ContainsKey($name)) {
            return $config[$name]
        }
    }
    return $Default
}

$llmProfileConfig = @{}
$loadedLlmProfile = Get-ConfigValue @("llm_profile") $null
if ($null -ne $loadedLlmProfile) {
    foreach ($property in $loadedLlmProfile.PSObject.Properties) {
        $llmProfileConfig[$property.Name] = $property.Value
    }
}

function Get-LlmProfileValue {
    param([string] $Name, $Default = "")
    if ($llmProfileConfig.ContainsKey($Name)) {
        return $llmProfileConfig[$Name]
    }
    return $Default
}

function New-TextBox {
    param([string] $Text = "", [bool] $Multiline = $false)
    $control = New-Object System.Windows.Forms.TextBox
    $control.Text = $Text
    $control.Dock = [System.Windows.Forms.DockStyle]::Fill
    if ($Multiline) {
        $control.Multiline = $true
        $control.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
        $control.AcceptsReturn = $true
    }
    return $control
}

function New-ComboBox {
    param([string[]] $Items, [string] $Selected)
    $control = New-Object System.Windows.Forms.ComboBox
    $control.Dock = [System.Windows.Forms.DockStyle]::Fill
    $control.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
    [void] $control.Items.AddRange($Items)
    $control.SelectedItem = if ($Items -contains $Selected) { $Selected } else { $Items[0] }
    return $control
}

function New-NumericControl {
    param([decimal] $Minimum, [decimal] $Maximum, [decimal] $Value)
    $control = New-Object System.Windows.Forms.NumericUpDown
    $control.Dock = [System.Windows.Forms.DockStyle]::Fill
    $control.Minimum = $Minimum
    $control.Maximum = $Maximum
    $control.ThousandsSeparator = $true
    $control.Value = [Math]::Min($Maximum, [Math]::Max($Minimum, $Value))
    return $control
}

function New-DecimalControl {
    param([decimal] $Minimum, [decimal] $Maximum, [decimal] $Value, [int] $DecimalPlaces = 2, [decimal] $Increment = 0.05)
    $control = New-NumericControl $Minimum $Maximum $Value
    $control.DecimalPlaces = $DecimalPlaces
    $control.Increment = $Increment
    return $control
}

function New-BrowseField {
    param([System.Windows.Forms.TextBox] $TextBox, [string] $Title)
    $panel = New-Object System.Windows.Forms.TableLayoutPanel
    $panel.Dock = [System.Windows.Forms.DockStyle]::Fill
    $panel.ColumnCount = 2
    $panel.RowCount = 1
    [void] $panel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
    [void] $panel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
    $button = New-Object System.Windows.Forms.Button
    $button.Text = "Browse..."
    $button.AutoSize = $true
    $button.Add_Click({
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = $Title
        $dialog.Filter = "GGUF files (*.gguf)|*.gguf|All files (*.*)|*.*"
        $dialog.CheckFileExists = $true
        if ($TextBox.Text.Trim()) {
            $currentDirectory = Split-Path -Parent $TextBox.Text.Trim()
            if (Test-Path -LiteralPath $currentDirectory -PathType Container) {
                $dialog.InitialDirectory = $currentDirectory
            }
        }
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            $TextBox.Text = $dialog.FileName
        }
    }.GetNewClosure())
    [void] $panel.Controls.Add($TextBox, 0, 0)
    [void] $panel.Controls.Add($button, 1, 0)
    return $panel
}

function Add-Field {
    param([string] $Label, [System.Windows.Forms.Control] $Control, [int] $Row, [string] $Help = "")
    $labelControl = New-Object System.Windows.Forms.Label
    $labelControl.Text = $Label
    $labelControl.AutoSize = $true
    $labelControl.Anchor = [System.Windows.Forms.AnchorStyles]::Left
    if ($Help) {
        $toolTip.SetToolTip($labelControl, $Help)
        $toolTip.SetToolTip($Control, $Help)
    }
    [void] $layout.Controls.Add($labelControl, 0, $Row)
    [void] $layout.Controls.Add($Control, 1, $Row)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Prompt Studio - Llama.cpp Config Builder"
$form.ClientSize = New-Object System.Drawing.Size(860, 720)
$form.MinimumSize = New-Object System.Drawing.Size(760, 680)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.Padding = New-Object System.Windows.Forms.Padding(16)
$root.ColumnCount = 1
$root.RowCount = 4
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void] $root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize)))

$intro = New-Object System.Windows.Forms.Label
$intro.AutoSize = $true
$intro.MaximumSize = New-Object System.Drawing.Size(810, 0)
$intro.Text = "Configure the llama-server process managed by Prompt Studio. Hover a field label for details.`r`nConfig file: $ConfigPath"
$intro.Padding = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
[void] $root.Controls.Add($intro, 0, 0)

$scroll = New-Object System.Windows.Forms.Panel
$scroll.Dock = [System.Windows.Forms.DockStyle]::Fill
$scroll.AutoScroll = $true
[void] $root.Controls.Add($scroll, 0, 1)

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.AutoSize = $true
$layout.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
$layout.Dock = [System.Windows.Forms.DockStyle]::Top
$layout.ColumnCount = 2
[void] $layout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 165)))
[void] $layout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100)))
[void] $scroll.Controls.Add($layout)
$toolTip = New-Object System.Windows.Forms.ToolTip

$modelText = New-TextBox ([string](Get-ConfigValue @("model_gguf", "model")))
$mmprojText = New-TextBox ([string](Get-ConfigValue @("mmproj_gguf", "mmproj")))
$contextSize = New-NumericControl 128 16777216 ([decimal](Get-ConfigValue @("context_size", "ctx_size") 32768))
$gpuLayers = New-TextBox ([string](Get-ConfigValue @("gpu_layers", "n_gpu_layers") "all"))
$parallelSlots = New-NumericControl 1 1024 ([decimal](Get-ConfigValue @("parallel_slots", "parallel") 1))
$cudaDevices = New-TextBox ([string](Get-ConfigValue @("cuda_devices")))
$cudaVisibleDevices = New-TextBox ([string](Get-ConfigValue @("cuda_visible_devices")))
$splitMode = New-ComboBox @("none", "layer", "row", "tensor") ([string](Get-ConfigValue @("split_mode") "layer"))
$mainGpu = New-NumericControl 0 1024 ([decimal](Get-ConfigValue @("main_gpu", "main_gpu_index") 0))
$tensorSplit = New-TextBox ([string](Get-ConfigValue @("tensor_split")))
$autoFit = New-ComboBox @("default", "on", "off") ([string](Get-ConfigValue @("auto_fit", "fit") "default"))
$flashAttention = New-ComboBox @("auto", "on", "off") ([string](Get-ConfigValue @("flash_attention", "flash_attn") "auto"))
$cacheTypes = @("f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1")
$cacheTypeK = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("kv_cache_k", "cache_type_k") "f16"))
$cacheTypeV = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("kv_cache_v", "cache_type_v") "f16"))
$mtpEnabled = New-ComboBox @("off", "on") ([string](Get-ConfigValue @("mtp_enabled", "mtp") "off"))
$mtpDraftTokens = New-NumericControl 1 1024 ([decimal](Get-ConfigValue @("mtp_draft_tokens", "spec_draft_n_max") 3))
$mtpMinDraftTokens = New-NumericControl 0 1024 ([decimal](Get-ConfigValue @("mtp_min_draft_tokens", "spec_draft_n_min") 0))
$mtpMinProbability = New-DecimalControl 0 1 ([decimal](Get-ConfigValue @("mtp_min_probability", "spec_draft_p_min") 0)) 3 0.05
$mtpGpuLayers = New-TextBox ([string](Get-ConfigValue @("mtp_gpu_layers", "spec_draft_gpu_layers") "auto"))
$mtpDevice = New-TextBox ([string](Get-ConfigValue @("mtp_device", "spec_draft_device")))
$mtpCacheTypeK = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("mtp_kv_cache_k", "spec_draft_cache_type_k") "f16"))
$mtpCacheTypeV = New-ComboBox $cacheTypes ([string](Get-ConfigValue @("mtp_kv_cache_v", "spec_draft_cache_type_v") "f16"))
$hostText = New-TextBox ([string](Get-ConfigValue @("host") "127.0.0.1"))
$port = New-NumericControl 1 65535 ([decimal](Get-ConfigValue @("port") 8080))
$existingExtraArgs = @(Get-ConfigValue @("extra_args") @())
$extraArgs = New-TextBox (($existingExtraArgs | ForEach-Object { [string] $_ }) -join "`r`n") $true
$extraArgs.MinimumSize = New-Object System.Drawing.Size(0, 80)
$thinkingModeOptions = @("Disabled", "Minimal", "Low", "Medium", "High", "XHigh")
$llmThinkingMode = New-ComboBox $thinkingModeOptions ([string](Get-LlmProfileValue "thinking_mode" "Disabled"))
$llmThinkingModes = New-TextBox (@(Get-LlmProfileValue "thinking_modes" @("Disabled", "Minimal", "Low", "Medium", "High")) -join ", ")
$standardThinkingModesText = "Disabled, Minimal, Low, Medium, High"
$qwen38ThinkingModesText = "XHigh, Medium, Low, Disabled"
$applyModelThinkingModes = {
    if (
        $modelText.Text -match '(?i)qwen\s*3[._-]?8' -and
        ($llmThinkingModes.Text.Trim() -eq $standardThinkingModesText -or -not $llmThinkingModes.Text.Trim())
    ) {
        $llmThinkingModes.Text = $qwen38ThinkingModesText
        $llmThinkingMode.SelectedItem = "XHigh"
    }
}
$modelText.Add_TextChanged($applyModelThinkingModes)
& $applyModelThinkingModes
$llmMaxResponseTokens = New-NumericControl 0 8192 ([decimal](Get-LlmProfileValue "max_response_tokens" 800))
$llmReasoningCap = New-NumericControl 0 262144 ([decimal](Get-LlmProfileValue "llamacpp_reasoning_budget_tokens" 0))
$llmSamplerSeed = New-NumericControl -1 999999 ([decimal](Get-LlmProfileValue "sampler_seed" -1))
$llmRequestTimeout = New-NumericControl 5 600 ([decimal](Get-LlmProfileValue "request_timeout" 120))
$llmTemperature = New-DecimalControl 0 5 ([decimal](Get-LlmProfileValue "temperature" 0.7)) 2 0.05
$llmTopP = New-DecimalControl 0 1 ([decimal](Get-LlmProfileValue "top_p" 0.9)) 2 0.01
$llmTopK = New-NumericControl 0 200 ([decimal](Get-LlmProfileValue "top_k" 100))
$llmMinP = New-DecimalControl 0 1 ([decimal](Get-LlmProfileValue "min_p" 0)) 2 0.01
$llmPresencePenalty = New-DecimalControl -2 2 ([decimal](Get-LlmProfileValue "presence_penalty" 0)) 2 0.05
$llmRepPen = New-DecimalControl 0.5 3 ([decimal](Get-LlmProfileValue "rep_pen" 1.05)) 2 0.01
$llmRepPenRange = New-NumericControl 0 4096 ([decimal](Get-LlmProfileValue "rep_pen_range" 360))
$llmThinkingTemperature = New-DecimalControl 0 5 ([decimal](Get-LlmProfileValue "thinking_temperature" 0.7)) 2 0.05
$llmThinkingTopP = New-DecimalControl 0 1 ([decimal](Get-LlmProfileValue "thinking_top_p" 0.9)) 2 0.01
$llmThinkingTopK = New-NumericControl 0 200 ([decimal](Get-LlmProfileValue "thinking_top_k" 100))
$llmThinkingMinP = New-DecimalControl 0 1 ([decimal](Get-LlmProfileValue "thinking_min_p" 0)) 2 0.01
$llmThinkingPresencePenalty = New-DecimalControl -2 2 ([decimal](Get-LlmProfileValue "thinking_presence_penalty" 0)) 2 0.05
$llmThinkingRepPen = New-DecimalControl 0.5 3 ([decimal](Get-LlmProfileValue "thinking_rep_pen" 1.05)) 2 0.01
$llmThinkingRepPenRange = New-NumericControl 0 4096 ([decimal](Get-LlmProfileValue "thinking_rep_pen_range" 360))
$llmStopSequence = New-TextBox ([string](Get-LlmProfileValue "stop_sequence" "")) $true
$llmStopSequence.MinimumSize = New-Object System.Drawing.Size(0, 60)

Add-Field "Model GGUF" (New-BrowseField $modelText "Select model GGUF") 0 "Required model weights file."
Add-Field "MMProj GGUF" (New-BrowseField $mmprojText "Select multimodal projector GGUF") 1 "Optional multimodal projector for vision models."
Add-Field "Context size" $contextSize 2 "Maximum context tokens allocated by llama-server."
Add-Field "GPU layers" $gpuLayers 3 "Use 'all' or a non-negative layer count."
Add-Field "Parallel slots" $parallelSlots 4 "Number of concurrent llama-server slots."
Add-Field "CUDA devices" $cudaDevices 5 "Optional value for llama.cpp --device, such as CUDA0,CUDA1."
Add-Field "CUDA visible devices" $cudaVisibleDevices 6 "Optional CUDA_VISIBLE_DEVICES environment value."
Add-Field "Split mode" $splitMode 7 "How model tensors are split across GPUs."
Add-Field "Main GPU" $mainGpu 8 "Physical CUDA GPU index. When CUDA devices filters the list, Prompt Studio translates this to llama.cpp's filtered-list index."
Add-Field "Tensor split" $tensorSplit 9 "Optional comma-separated proportions, such as 2,1,1."
Add-Field "Auto-fit" $autoFit 10 "Use default to omit --fit, or explicitly turn it on/off."
Add-Field "Flash attention" $flashAttention 11 "Automatic, enabled, or disabled flash attention."
Add-Field "KV cache K" $cacheTypeK 12 "Key-cache data type."
Add-Field "KV cache V" $cacheTypeV 13 "Value-cache data type."
Add-Field "MTP" $mtpEnabled 14 "Enable the model's built-in Multi-Token Prediction head for speculative decoding. Requires a compatible MTP GGUF and recent llama.cpp build."
Add-Field "MTP draft tokens" $mtpDraftTokens 15 "Maximum number of tokens drafted per speculative-decoding step."
Add-Field "MTP minimum tokens" $mtpMinDraftTokens 16 "Minimum useful draft length. Must not exceed MTP draft tokens."
Add-Field "MTP minimum probability" $mtpMinProbability 17 "Stop drafting when the next draft token probability falls below this value (0 to 1)."
Add-Field "MTP GPU layers" $mtpGpuLayers 18 "Draft-model GPU layers: 'auto', 'all', or a non-negative layer count."
Add-Field "MTP device" $mtpDevice 19 "Optional comma-separated llama.cpp device list for the MTP draft context."
Add-Field "MTP KV cache K" $mtpCacheTypeK 20 "Key-cache data type for the MTP draft context."
Add-Field "MTP KV cache V" $mtpCacheTypeV 21 "Value-cache data type for the MTP draft context."
Add-Field "Host" $hostText 22 "Address llama-server listens on."
Add-Field "Port" $port 23 "Port llama-server listens on."
Add-Field "Extra arguments" $extraArgs 24 "Optional raw llama.cpp arguments, one token per line."
Add-Field "Default thinking mode" $llmThinkingMode 25 "Default reasoning effort for this model config. Qwen 3.8 defaults to XHigh."
Add-Field "Available thinking modes" $llmThinkingModes 26 "Comma-separated list. Qwen 3.8 uses XHigh, Medium, and Low; Disabled is its separate no-thinking switch. Other models may use Disabled, Minimal, Low, Medium, and High."
Add-Field "Response tokens" $llmMaxResponseTokens 27 "Maximum final-answer tokens. Use 0 for the request-specific automatic limit."
Add-Field "Reasoning token cap" $llmReasoningCap 28 "Use 0 for model-controlled reasoning. A positive value forcibly ends thinking after this many tokens."
Add-Field "Sampler seed" $llmSamplerSeed 29 "Use -1 to let llama.cpp choose a random seed."
Add-Field "Request timeout" $llmRequestTimeout 30 "Request timeout in seconds."
Add-Field "Temperature" $llmTemperature 31 "Non-thinking sampler temperature."
Add-Field "Top P" $llmTopP 32 "Non-thinking nucleus-sampling probability."
Add-Field "Top K" $llmTopK 33 "Non-thinking top-k sampler value."
Add-Field "Min P" $llmMinP 34 "Non-thinking minimum-token probability."
Add-Field "Presence penalty" $llmPresencePenalty 35 "Non-thinking presence penalty."
Add-Field "Repeat penalty" $llmRepPen 36 "Non-thinking repetition penalty."
Add-Field "Repeat range" $llmRepPenRange 37 "Non-thinking repetition lookback range."
Add-Field "Thinking temperature" $llmThinkingTemperature 38 "Sampler temperature used whenever thinking is enabled."
Add-Field "Thinking Top P" $llmThinkingTopP 39 "Thinking nucleus-sampling probability."
Add-Field "Thinking Top K" $llmThinkingTopK 40 "Thinking top-k sampler value."
Add-Field "Thinking Min P" $llmThinkingMinP 41 "Thinking minimum-token probability."
Add-Field "Thinking presence" $llmThinkingPresencePenalty 42 "Thinking presence penalty."
Add-Field "Thinking repeat penalty" $llmThinkingRepPen 43 "Thinking repetition penalty."
Add-Field "Thinking repeat range" $llmThinkingRepPenRange 44 "Thinking repetition lookback range."
Add-Field "Stop sequences" $llmStopSequence 45 "Optional stop sequences, one per line."

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.AutoSize = $true
$statusLabel.ForeColor = [System.Drawing.Color]::DarkGreen
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 8)
$statusLabel.Text = if (Test-Path -LiteralPath $ConfigPath) { "Existing config loaded." } else { "A new config will be created." }
[void] $root.Controls.Add($statusLabel, 0, 2)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.AutoSize = $true
$buttons.Dock = [System.Windows.Forms.DockStyle]::Fill
$buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "Save config"
$saveButton.AutoSize = $true
$saveButton.MinimumSize = New-Object System.Drawing.Size(105, 32)
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.AutoSize = $true
$cancelButton.MinimumSize = New-Object System.Drawing.Size(90, 32)
[void] $buttons.Controls.Add($saveButton)
[void] $buttons.Controls.Add($cancelButton)
[void] $root.Controls.Add($buttons, 0, 3)

$cancelButton.Add_Click({ $form.Close() })
$saveButton.Add_Click({
    try {
        $model = $modelText.Text.Trim()
        $mmproj = $mmprojText.Text.Trim()
        if (-not (Test-Path -LiteralPath $model -PathType Leaf)) {
            throw "Select an existing model GGUF file."
        }
        if ($mmproj -and -not (Test-Path -LiteralPath $mmproj -PathType Leaf)) {
            throw "The selected MMProj GGUF does not exist."
        }
        $gpuLayerValue = $gpuLayers.Text.Trim().ToLowerInvariant()
        if ($gpuLayerValue -notmatch '^(all|[0-9]+)$') {
            throw "GPU layers must be 'all' or a non-negative number."
        }
        $tensorSplitValue = $tensorSplit.Text.Trim()
        if ($tensorSplitValue -and $tensorSplitValue -notmatch '^[0-9]+(?:\.[0-9]+)?(?:,[0-9]+(?:\.[0-9]+)?)*$') {
            throw "Tensor split must be a comma-separated numeric list, such as 2,1,1."
        }
        if ($mtpMinDraftTokens.Value -gt $mtpDraftTokens.Value) {
            throw "MTP minimum tokens cannot exceed MTP draft tokens."
        }
        $mtpGpuLayerValue = $mtpGpuLayers.Text.Trim().ToLowerInvariant()
        if ($mtpGpuLayerValue -notmatch '^(auto|all|[0-9]+)$') {
            throw "MTP GPU layers must be 'auto', 'all', or a non-negative number."
        }
        $hostValue = $hostText.Text.Trim()
        if (-not $hostValue -or $hostValue -match '\s') {
            throw "Host must be non-empty and cannot contain whitespace."
        }
        $arguments = @($extraArgs.Lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($arguments.Count -gt 128 -or ($arguments | Where-Object { $_.Length -gt 4096 -or $_.Contains([char]0) })) {
            throw "Extra arguments are too large or contain invalid values."
        }
        $requestedThinkingModes = @(
            $llmThinkingModes.Text -split '[,\r\n]+' |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ }
        )
        if (-not $requestedThinkingModes.Count) {
            throw "Select at least one available thinking mode."
        }
        $normalizedThinkingModes = New-Object System.Collections.Generic.List[string]
        foreach ($requestedMode in $requestedThinkingModes) {
            $normalizedMode = $thinkingModeOptions | Where-Object { $_ -ieq $requestedMode } | Select-Object -First 1
            if (-not $normalizedMode) {
                throw "Thinking modes may contain only: $($thinkingModeOptions -join ', ')."
            }
            if (-not $normalizedThinkingModes.Contains($normalizedMode)) {
                [void] $normalizedThinkingModes.Add($normalizedMode)
            }
        }
        $defaultThinkingMode = [string] $llmThinkingMode.SelectedItem
        if (-not $normalizedThinkingModes.Contains($defaultThinkingMode)) {
            throw "Default thinking mode must also appear in Available thinking modes."
        }
        $stopSequenceValue = $llmStopSequence.Text
        if ($stopSequenceValue.Length -gt 4096 -or $stopSequenceValue.Contains([char]0)) {
            throw "Stop sequences must not exceed 4096 characters or contain null characters."
        }

        $savedConfig = [ordered]@{
            model_gguf = [System.IO.Path]::GetFullPath($model)
            mmproj_gguf = if ($mmproj) { [System.IO.Path]::GetFullPath($mmproj) } else { "" }
            context_size = [int] $contextSize.Value
            gpu_layers = $gpuLayerValue
            parallel_slots = [int] $parallelSlots.Value
            cuda_devices = $cudaDevices.Text.Trim()
            cuda_visible_devices = $cudaVisibleDevices.Text.Trim()
            split_mode = [string] $splitMode.SelectedItem
            main_gpu = [int] $mainGpu.Value
            tensor_split = $tensorSplitValue
            auto_fit = [string] $autoFit.SelectedItem
            flash_attention = [string] $flashAttention.SelectedItem
            kv_cache_k = [string] $cacheTypeK.SelectedItem
            kv_cache_v = [string] $cacheTypeV.SelectedItem
            mtp_enabled = [string] $mtpEnabled.SelectedItem
            mtp_draft_tokens = [int] $mtpDraftTokens.Value
            mtp_min_draft_tokens = [int] $mtpMinDraftTokens.Value
            mtp_min_probability = [double] $mtpMinProbability.Value
            mtp_gpu_layers = $mtpGpuLayerValue
            mtp_device = $mtpDevice.Text.Trim()
            mtp_kv_cache_k = [string] $mtpCacheTypeK.SelectedItem
            mtp_kv_cache_v = [string] $mtpCacheTypeV.SelectedItem
            host = $hostValue
            port = [int] $port.Value
            extra_args = $arguments
            llm_profile = [ordered]@{
                thinking_mode = $defaultThinkingMode
                thinking_modes = @($normalizedThinkingModes)
                max_response_tokens = [int] $llmMaxResponseTokens.Value
                llamacpp_reasoning_budget_tokens = [int] $llmReasoningCap.Value
                temperature = [double] $llmTemperature.Value
                top_p = [double] $llmTopP.Value
                top_k = [int] $llmTopK.Value
                min_p = [double] $llmMinP.Value
                presence_penalty = [double] $llmPresencePenalty.Value
                rep_pen = [double] $llmRepPen.Value
                rep_pen_range = [int] $llmRepPenRange.Value
                thinking_temperature = [double] $llmThinkingTemperature.Value
                thinking_top_p = [double] $llmThinkingTopP.Value
                thinking_top_k = [int] $llmThinkingTopK.Value
                thinking_min_p = [double] $llmThinkingMinP.Value
                thinking_presence_penalty = [double] $llmThinkingPresencePenalty.Value
                thinking_rep_pen = [double] $llmThinkingRepPen.Value
                thinking_rep_pen_range = [int] $llmThinkingRepPenRange.Value
                sampler_seed = [int] $llmSamplerSeed.Value
                request_timeout = [int] $llmRequestTimeout.Value
                stop_sequence = $stopSequenceValue
            }
        }
        $json = $savedConfig | ConvertTo-Json -Depth 6
        $temporaryPath = "$ConfigPath.$([System.Guid]::NewGuid().ToString('N')).tmp"
        try {
            [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
            Move-Item -LiteralPath $temporaryPath -Destination $ConfigPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkGreen
        $statusLabel.Text = "Saved Prompt Studio Llama.cpp config."
        [System.Windows.Forms.MessageBox]::Show(
            "The Llama.cpp config was saved to:`r`n$ConfigPath",
            "Prompt Studio",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    }
    catch {
        $statusLabel.ForeColor = [System.Drawing.Color]::DarkRed
        $statusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Could not save config",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

[void] $form.Controls.Add($root)
$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton
[void] $form.ShowDialog()
