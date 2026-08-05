/** Arabic-to-English translation map for developer names, locations, and common terms. */

const ARABIC_TO_ENGLISH = {
  // // Developers
  // "سوديك": "SODIC",
  // "حسن علام": "Hassan Allam",
  // "ماونتن فيو": "Mountain View",
  // "بالم هيلز": "Palm Hills",
  // "إعمار": "Emaar",
  // "لافيستا": "La Vista",
  // "طلعت مصطفى": "Talaat Moustafa",
  // "سيتي إيدج": "City Edge",
  // "مراكز": "Marakez",
  // "أورا": "Ora",
  // "هايد بارك": "Hyde Park",
  // "المراسم": "Al Marasem",
  // "سيرا": "Cira",
  // "مدينة مصر": "Madinet Masr",
  // "الأهلي صبور": "Al Ahly Sabbour",
  // "درة": "Dorra",
  // "وادي دجلة": "Wadi Degla",
  // "إل كازار": "El Cazar",
  // "نيو جيزة": "New Giza",
  // // Locations
  // "القاهرة الجديدة": "New Cairo",
  // "التجمع الخامس": "New Cairo",
  "العاصمة الإدارية": "New Capital",
  "العاصمة الادارية": "New Capital",
  // "الساحل الشمالي": "North Coast",
  "6 أكتوبر": "6 October",
  "السادس من أكتوبر": "6 October",
  // "اكتوبر": "6 October",
  // West/East Cairo region-group members whose Arabic name the Location API
  // doesn't match directly — map to the English name it DOES resolve.
  "حدائق أكتوبر": "October Gardens",
  "أكتوبر الجديدة": "New October",
  "نيو هليوبلس": "New Heliopolis",
  "هليوبلس الجديدة": "New Heliopolis",
  "هليوبوليس الجديدة": "New Heliopolis",
  // التجمع الخامس doesn't resolve in the Location API — redirect it to
  // التجمع السادس (6th Settlement, id 33), per business rule.
  "التجمع الخامس": "5th Settlement", // Redirect to 6th Settlement
  "الاسكندرية": "Alexandria",
  // Hamza/alif spelling variants the Location API doesn't match directly.
  "الإسكندرية": "Alexandria",
  "اسكندرية": "Alexandria",
  "إسكندرية": "Alexandria",
  // "الشيخ زايد": "Zayed",
  // "زايد الجديدة": "New Zayed",
  // "مدينة المستقبل": "Mostakbal City",
  // "المستقبل": "Mostakbal City",
  // "العين السخنة": "Ain Sokhna",
  // "مدينة الشروق": "Shorouk City",
  // "الشروق": "Shorouk City",
  // "المعادي": "Maadi",
  // "مدينتي": "Madinaty",
  // "الرحاب": "Rehab",
  // "العبور": "Obour",
  // "راس الحكمة": "Ras El Hekma",
  // "الجونة": "El Gouna",
  // Commission labels
  "العمولة العادية": "Normal Commission",
  "عمولة الكاش": "On-Spot Commission",
  "تُدفع خلال أسبوع": "Paid within one week",
  // Response labels
  "المشروع": "Project",
  "الموقع": "Location",
  "المطور العقاري": "Developer",
  "الأسعار": "Prices",
  "التفاصيل": "Details",
  "التشطيب": "Finishing",
  "التسليم": "Delivery",
  "مقدم": "Down Payment",
  "تقسيط": "Installments",
  "الوحدات المتاحة": "Available Units",
  "مسؤول المبيعات": "Sales Contact",
  "الحالة": "Status",
  "السعر": "Price",
  "المساحة": "Area",
  "النوع": "Type",
  "الفئة": "Category",
  "نظام السداد": "Payment Plan",
  "متر مربع": "sqm",
  "جنيه": "EGP",
  "سنوات": "years",
  "سنة": "year",
  // Finishing types
  "بدون تشطيب": "CORE-SHELL",
  "تشطيب كامل": "FULLY-FINISHED",
  "نص تشطيب": "SEMI-FINISHED",
  // Delivery options
  "جاهز للسكن": "READY-TO-MOVE",
  "بعد سنة": "AFTER-ONE-YEAR",
  "بعد سنتين": "AFTER-TWO-YEARS",
  "بعد 3 سنوات": "AFTER-THREE-YEARS",
  "بعد 4 سنوات": "AFTER-FOUR-YEARS",
  "بعد 5 سنوات": "AFTER-FIVE-YEARS",
  // Property type — all Arabic spellings of "compound"
  "كمبوند": "COMPOUND",
  "كمباوند": "COMPOUND",
  "كومباوند": "COMPOUND",
  "كومبوند": "COMPOUND",
  "كمبند": "COMPOUND",
  "كومبند": "COMPOUND",
  "مجمع سكني": "COMPOUND",
  "مركب": "COMPOUND",
  "مستقل": "SEPARATE",
  "سيبريت": "SEPARATE",
  "منفصل": "SEPARATE",
  // Status values
  "متاح": "Available",
  "غير متاح": "Sold Out",
  "محجوز": "Reserved",
  // Categories (include common plurals — the catalog stores singular names,
  // and substring replacement won't turn a plural like "شقق" into "شقة")
  "شقق": "Apartment",
  "شقة": "Apartment",
  "فلل": "Villa",
  "فيلات": "Villa",
  "شاليهات": "Chalet",
  "شاليه": "Chalet",
  "مكاتب": "Office",
  "عيادات": "Clinic",
  "فيلا": "Villa",
  "تاون هاوس": "Townhouse",
  "توين هاوس": "Twin House",
  "دوبلكس": "Duplex",
  "بنتهاوس": "Penthouse",
  "استوديو": "Studio",
  "تجاري": "Commercial",
  "إداري": "Administrative",
  // Unit types — bedroom counts. Include the formal MSA forms (with "نوم"),
  // the short forms (no "نوم"), and the Egyptian-dialect "اوضة/أوض" variants,
  // because voice users say e.g. "ثلاث غرف" or "تلات اوض", not "ثلاث غرف نوم".
  // (Sorted longest-first at load time, so "ثلاث غرف نوم" still wins over the
  //  shorter "ثلاث غرف" when the user does say the full phrase.)
  "غرفة نوم واحدة": "ONE-BEDROOM",
  "غرفة نوم": "ONE-BEDROOM",
  "غرفة واحدة": "ONE-BEDROOM",
  "اوضة واحدة": "ONE-BEDROOM",
  "أوضة واحدة": "ONE-BEDROOM",
  "غرفتين نوم": "TWO-BEDROOM",
  "غرفتين": "TWO-BEDROOM",
  "اوضتين": "TWO-BEDROOM",
  "أوضتين": "TWO-BEDROOM",
  "ثلاث غرف نوم": "THREE-BEDROOM",
  "ثلاث غرف": "THREE-BEDROOM",
  "تلات غرف": "THREE-BEDROOM",
  "تلاتة غرف": "THREE-BEDROOM",
  "تلات اوض": "THREE-BEDROOM",
  "تلات أوض": "THREE-BEDROOM",
  "أربع غرف نوم": "FOUR-BEDROOM",
  "أربع غرف": "FOUR-BEDROOM",
  "اربع غرف": "FOUR-BEDROOM",
  "اربع اوض": "FOUR-BEDROOM",
  "أربع أوض": "FOUR-BEDROOM",
  "توين فيلا": "TWIN",
  "ستاند ألون": "STAND-ALONE",
  "فيلا مستقلة": "STAND-ALONE",
  "عيادة": "CLINIC",
  "صيدلية": "PHARMACY",
  "مكتب": "OFFICE",
   "محل": "SHOP"
};

/** English-to-Arabic translation map for response labels and unit types. */
const ENGLISH_TO_ARABIC = {
  // Commission labels
  "Normal Commission:": "العمولة العادية:",
  "On-Spot Commission:": "عمولة الكاش:",
  "Paid within one week": "تُدفع خلال أسبوع",
  // Response labels
  "Project:": "المشروع:",
  "Location:": "الموقع:",
  "Developer:": "المطور العقاري:",
  "Prices:": "الأسعار:",
  "Details:": "التفاصيل:",
  "Finishing:": "التشطيب:",
  "Delivery:": "التسليم:",
  "Down Payment:": "مقدم:",
  "Installments:": "تقسيط:",
  "Available Units:": "الوحدات المتاحة:",
  "Sales Contact:": "مسؤول المبيعات:",
  "Status:": "الحالة:",
  "Price:": "السعر:",
  "Area:": "المساحة:",
  "Type:": "النوع:",
  "Category:": "الفئة:",
  "Payment Plan:": "نظام السداد:",
  " sqm": " متر مربع",
  " EGP": " جنيه",
  " years": " سنوات",
  " year": " سنة",
  // Finishing types
  "CORE-SHELL": "بدون تشطيب",
  "FULLY-FINISHED": "تشطيب كامل",
  "SEMI-FINISHED": "نص تشطيب",
  // Delivery options (backend uses mixed case "READY-To-MOVE")
  "READY-To-MOVE": "جاهز للسكن",
  "READY-TO-MOVE": "جاهز للسكن",
  "AFTER-ONE-YEAR": "بعد سنة",
  "AFTER-TWO-YEARS": "بعد سنتين",
  "AFTER-THREE-YEARS": "بعد 3 سنوات",
  "AFTER-FOUR-YEARS": "بعد 4 سنوات",
  "AFTER-FIVE-YEARS": "بعد 5 سنوات",
  // Unit types
  "ONE-BEDROOM": "غرفة نوم واحدة",
  "TWO-BEDROOM": "غرفتين نوم",
  "THREE-BEDROOM": "ثلاث غرف نوم",
  "FOUR-BEDROOM": "أربع غرف نوم",
  "STAND-ALONE": "فيلا مستقلة",
  "S-VILLA": "فيلا",
  "TWIN": "توين فيلا",
  "TOWN": "تاون هاوس",
  "DUPLEX": "دوبلكس",
  "PENTHOUSE": "بنتهاوس",
  "STUDIO": "استوديو",
  "SERVICE-APARTMENT": "شقة فندقية",
  "CLINIC": "عيادة",
  "PHARMACY": "صيدلية",
  "OFFICE": "مكتب",
  "SHOP": "محل",
  // Categories
  "Apartment": "شقة",
  "Villa": "فيلا",
  "Townhouse": "تاون هاوس",
  "Twin House": "توين هاوس",
  "Penthouse": "بنتهاوس",
  "Studio": "استوديو",
  "Commercial": "تجاري",
  "Administrative": "إداري",
  "Compound": "كومباوند",
  // Status values
  "Available": "متاح",
  "Sold Out": "غير متاح",
  "Reserved": "محجوز",
  "6 October": "6 أكتوبر",
  "6 October": "السادس من أكتوبر",
};

// Sort entries longest-first so specific phrases match before their substrings do
const AR_TO_EN_ENTRIES = Object.entries(ARABIC_TO_ENGLISH).sort((a, b) => b[0].length - a[0].length);
const EN_TO_AR_ENTRIES = Object.entries(ENGLISH_TO_ARABIC).sort((a, b) => b[0].length - a[0].length);

/**
 * Translate Arabic terms to English using the mapping. Returns the translated text.
 */
export function translateArabic(text) {
  if (!text) return text;
  if (typeof text !== "string") return text;
  let result = text;
  for (const [arabic, english] of AR_TO_EN_ENTRIES) {
    if (result.includes(arabic)) {
      result = result.replaceAll(arabic, english);
    }
  }
  // Fix word order: "years 10" → "10 years" (Arabic number placement)
  result = result.replace(/\byears\s+(\d+)\b/g, "$1 years");
  result = result.replace(/\byear\s+(\d+)\b/g, "$1 year");
  return result;
}

/**
 * Translate English labels/units to Arabic for Arabic-language responses.
 */
export function translateToArabic(text) {
  if (!text) return text;
  if (typeof text !== "string") return text;
  let result = text;
  for (const [english, arabic] of EN_TO_AR_ENTRIES) {
    if (result.includes(english)) {
      result = result.replaceAll(english, arabic);
    }
  }
  // Fix spacing: add space between digits and Arabic letters
  result = result.replace(/(\d)([\u0600-\u06FF])/g, "$1 $2");
  result = result.replace(/([\u0600-\u06FF])(\d)/g, "$1 $2");
  return result;
}
