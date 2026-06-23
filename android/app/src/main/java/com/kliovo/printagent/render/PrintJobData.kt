package com.kliovo.printagent.render

data class ReceiptHeader(
    val tenantName: String,
    val branchName: String? = null,
    val addressLines: List<String>? = null,
    val phone: String? = null,
    val taxLines: List<String>? = null,
    val rasterLogo: RasterLogo? = null
)

data class RasterLogo(
    val bytes: ByteArray,
    val widthBytes: Int,
    val heightDots: Int
)

data class ReceiptFooter(
    val lines: List<String>? = null,
    val qrLink: String? = null,
    val fbrVerifyUrl: String? = null
)

data class ReceiptItem(
    val name: String,
    val nameAlt: String? = null,
    val quantity: Int,
    val unitPricePaisa: Long,
    val totalPricePaisa: Long,
    val modifiers: List<ItemModifier>? = null,
    val notes: String? = null
)

data class ItemModifier(
    val name: String,
    val pricePaisa: Long = 0
)

data class ReceiptPayment(
    val method: String,
    val amountPaisa: Long,
    val tipPaisa: Long = 0,
    val reference: String? = null
)

data class Discount(
    val label: String,
    val amountPaisa: Long,
    val percentage: Double? = null
)

data class Tax(
    val label: String,
    val rate: Double,
    val amountPaisa: Long
)

data class Customer(
    val name: String? = null,
    val phone: String? = null
)

data class SectionStyle(
    val visible: Boolean? = null,
    val fontSize: String? = null,
    val align: String? = null,
    val bold: Boolean? = null,
    val nameSize: String? = null,
    val totalSize: String? = null,
    val lines: List<String>? = null
)

data class LayoutConfig(
    val paperWidth: Int? = null,
    val header: SectionStyle? = null,
    val orderMeta: SectionStyle? = null,
    val items: SectionStyle? = null,
    val totals: SectionStyle? = null,
    val payments: SectionStyle? = null,
    val footer: SectionStyle? = null
)

data class ReceiptInput(
    val paperWidth: Int = 80,
    val header: ReceiptHeader,
    val footer: ReceiptFooter? = null,
    val referenceNumber: String,
    val date: String,
    val time: String,
    val orderType: String,
    val tableName: String? = null,
    val serverName: String? = null,
    val covers: Int? = null,
    val customer: Customer? = null,
    val deliveryAddress: String? = null,
    val specialRequests: String? = null,
    val items: List<ReceiptItem>,
    val subtotalPaisa: Long,
    val discounts: List<Discount>? = null,
    val taxes: List<Tax>? = null,
    val serviceChargePaisa: Long? = null,
    val tipPaisa: Long? = null,
    val totalPaisa: Long,
    val paidPaisa: Long,
    val balanceDuePaisa: Long,
    val payments: List<ReceiptPayment>,
    val fbrInvoiceNumber: String? = null,
    val version: Int? = null,
    val layoutConfig: LayoutConfig? = null
)

data class KotItem(
    val name: String,
    val nameAlt: String? = null,
    val quantity: Int,
    val modifiers: List<KotModifier>? = null,
    val notes: String? = null,
    val course: String? = null
)

data class KotModifier(val name: String)

data class KotInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val stationName: String,
    val stationEmoji: String? = null,
    val tableName: String? = null,
    val guestName: String? = null,
    val serverName: String? = null,
    val orderType: String? = null,
    val fireTime: String,
    val fireDate: String? = null,
    val isUrgent: Boolean = false,
    val urgencyLabel: String? = null,
    val isRecall: Boolean = false,
    val items: List<KotItem>,
    val version: Int? = null
)

data class MasterKotStationGroup(
    val stationName: String,
    val stationEmoji: String? = null,
    val items: List<KotItem>
)

data class MasterKotInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val tableName: String? = null,
    val guestName: String? = null,
    val serverName: String? = null,
    val orderType: String? = null,
    val fireTime: String,
    val fireDate: String? = null,
    val covers: Int? = null,
    val courseLabel: String? = null,
    val groups: List<MasterKotStationGroup>,
    val version: Int? = null
)

data class VoidKotItem(
    val name: String,
    val quantity: Int,
    val modifiers: List<KotModifier>? = null
)

data class VoidKotInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val stationName: String? = null,
    val tableName: String? = null,
    val serverName: String? = null,
    val authorisedBy: String? = null,
    val reason: String? = null,
    val voidTime: String,
    val voidDate: String? = null,
    val items: List<VoidKotItem>
)

data class LabelInput(
    val paperWidth: Int = 80,
    val referenceNumber: String,
    val bagIndex: Int? = null,
    val bagTotal: Int? = null,
    val customerName: String? = null,
    val customerPhone: String? = null,
    val deliveryAddress: String? = null,
    val orderType: String? = null,
    val scheduledFor: String? = null,
    val itemSummary: String? = null,
    val handlingNote: String? = null
)
