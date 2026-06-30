import {
  useState,
} from "react";
import { TagInput } from "@/components/sell/TagInput";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/hooks/useWallet";
import {
  RevenueSplitFormInput,
} from "@/lib/validation/listing";

interface FormData {
  imageUrl: string;
  title: string;
  category: string;
  previewText: string;
  description: string;
  fullPrompt: string;
  priceXlm: string;
  tags: string[];
  coCreators: RevenueSplitFormInput[];
}

const createEmptyFormData = (): FormData => ({
  imageUrl: "",
  title: "",
  category: "",
  previewText: "",
  description: "",
  fullPrompt: "",
  priceXlm: "2",
  tags: [],
  coCreators: [],
});

export function CreatePromptForm() {
  useWallet();
  const [formData, setFormData] = useState<FormData>(createEmptyFormData);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-sm font-medium">Tags</label>
        <TagInput
          value={formData.tags}
          onChange={(tags) =>
            setFormData((prev) => ({ ...prev, tags }))
          }
        />
      </div>

      <Button className="w-full bg-emerald-400 text-slate-950 hover:bg-emerald-300">
        Create prompt listing
      </Button>
    </div>
  );
}
